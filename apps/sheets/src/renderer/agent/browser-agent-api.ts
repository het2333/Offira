import {
  BoundedEditorCache,
  createEditorResultJournal,
  editorRequestFingerprint,
  type BrowserWorkingCopyPayload,
  type BrowserWorkingCopyPersistence,
  type createWorkingCopyMutationLane,
} from '@nexusdesk/web-client'
import {
  PROTOCOL_VERSION,
  type AgentToolResult,
  type ApprovedEditPlan,
  type ClientId,
  type DocumentId,
  type EditorAdapter,
  type EditPlan,
  type EditorRequestFrame,
  type JsonValue,
  type Revision,
  type PersistenceReference,
  type WorkingCopyBootstrap,
} from '@nexusdesk/protocol'
import {
  createAgentApi,
  registerEditor,
  type AgentApi,
  type EditorRegistrationHandle,
  type NexusClient,
} from '@nexusdesk/web-client'

export interface BrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: EditorAdapter): void
  client(): { clientId: ClientId | undefined; attached: boolean }
  consumeApproval(approvalId: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  setHydrated(state: WorkingCopyBootstrap | null): void
  dispose(): void
}

export interface BrowserAgentBridgeOptions {
  client: NexusClient
  documentId: DocumentId
  revision: Revision
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  workingCopy?: {
    state(): WorkingCopyBootstrap | null
    persistence: BrowserWorkingCopyPersistence
    capture(): Promise<BrowserWorkingCopyPayload>
    preflight?(operations: readonly JsonValue[]): void
    lane: ReturnType<typeof createWorkingCopyMutationLane>
    lock?(): () => void
    committed(receipt: PersistenceReference): void
    afterSave?(): Promise<void>
    failed?(): void
  }
}

function failure(code: string, message: string): AgentToolResult {
  return { ok: false, summary: message, warnings: [{ code, message }] }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`
}

function sessionStorageOrUndefined():
  Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

export function createBrowserAgentBridge(options: BrowserAgentBridgeOptions): BrowserAgentBridge {
  let adapter: EditorAdapter | undefined
  let disposed = false
  // Serialize only fingerprint/registration, not execution, to preserve first-arrival ownership.
  let requestQueue: Promise<void> = Promise.resolve()
  const releasedProposals = new BoundedEditorCache<string, boolean>()
  const terminalResults = new Map<
    string,
    { fingerprint: string; result: Promise<AgentToolResult> }
  >()
  const approvals = new Map<string, string>()
  const saveProposals = new BoundedEditorCache<
    string,
    { planHash: string; snapshotHash: string; snapshot: string; adapter: EditorAdapter }
  >()
  const proposals = new BoundedEditorCache<string, EditPlan>()
  const proposalSnapshots = new BoundedEditorCache<string, string>()
  const storage = options.storage ?? sessionStorageOrUndefined()
  const journal = createEditorResultJournal(storage, options.documentId, {
    requirePersistence: !!options.workingCopy,
  })
  const receipts = new BoundedEditorCache<string, PersistenceReference>()
  const registration: EditorRegistrationHandle = registerEditor(options.client, {
    documentId: options.documentId,
    editorType: 'sheets',
    revision: options.revision,
    workingCopy: !!options.workingCopy,
  })

  const sendResult = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    options.client.send({
      type: 'editor:result',
      protocolVersion: PROTOCOL_VERSION,
      id: frame.id,
      target: frame.target,
      result,
      ...(receipts.get(frame.target.operationId)
        ? { persistence: receipts.get(frame.target.operationId)! }
        : {}),
    })
  }

  const deliverResult = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    try {
      sendResult(frame, result)
    } catch {
      // The durable journal is the source of truth. Reconnect lookup/replay
      // delivers the same result without executing the editor command again.
    }
  }

  const execute = async (frame: EditorRequestFrame): Promise<AgentToolResult> => {
    if (adapter === undefined) {
      return failure('EDITOR_NOT_READY', 'the spreadsheet editor is not ready')
    }
    if (frame.command === 'read_sheet') {
      return adapter.read({
        documentId: frame.target.documentId,
        command: frame.command,
        arguments: frame.arguments,
      })
    }
    if (frame.command === 'propose_save') {
      const saveAdapter = adapter as EditorAdapter & { saveSnapshot?(): string }
      if (!saveAdapter.saveSnapshot)
        return failure(
          'SAVE_SNAPSHOT_UNAVAILABLE',
          'the editor cannot prepare an exact save snapshot',
        )
      const snapshot = saveAdapter.saveSnapshot()
      const digest = async (value: string): Promise<string> => {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
        return [...new Uint8Array(bytes)]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
      }
      const snapshotHash = await digest(snapshot)
      const planHash = await digest(
        canonical({ target: frame.target, command: 'save_sheet', snapshotHash }),
      )
      saveProposals.set(frame.target.operationId, {
        planHash,
        snapshotHash,
        snapshot,
        adapter: saveAdapter,
      })
      return {
        ok: true,
        summary: 'Save the proposed document snapshot in place.',
        warnings: [],
        data: {
          operationId: frame.target.operationId,
          planHash,
          snapshotHash,
          summary: 'Save the proposed document snapshot in place.',
          targets: ['current document'],
        },
      }
    }
    if (frame.command === 'save_sheet') {
      const plan = saveProposals.get(frame.target.operationId)
      const args = frame.arguments as Record<string, unknown>
      if (
        !plan ||
        !frame.approval ||
        frame.approval.planHash !== plan.planHash ||
        args.snapshotHash !== plan.snapshotHash
      ) {
        return failure(
          'APPROVAL_INVALID',
          'save request is not bound to an exact proposed snapshot',
        )
      }
      saveProposals.delete(frame.target.operationId)
      const saveAdapter = adapter as EditorAdapter & { saveSnapshot?(): string }
      if (saveAdapter !== plan.adapter || saveAdapter.saveSnapshot?.() !== plan.snapshot) {
        return failure(
          'STALE_CONTENT',
          'the editor changed after this save was proposed; propose it again',
        )
      }
      // The shared coordinator performs preparation and promotion for this approved Save.
      if (options.workingCopy)
        return { ok: true, summary: 'Saved the current workbook.', warnings: [] }
      return saveAdapter.save(frame.target.documentId)
    }
    if (frame.command === 'propose_ops') {
      const saveAdapter = adapter as EditorAdapter & { saveSnapshot?(): string }
      const snapshot = saveAdapter.saveSnapshot?.()
      const plan = await adapter.propose({
        ...frame.target,
        command: 'apply_ops',
        arguments: frame.arguments,
      })
      options.workingCopy?.preflight?.(plan.operations)
      if (snapshot !== undefined) {
        if (saveAdapter.saveSnapshot?.() !== snapshot)
          return failure('STALE_CONTENT', 'The workbook changed while preparing this plan.')
        proposalSnapshots.set(frame.target.operationId, snapshot)
      }
      proposals.set(frame.target.operationId, plan)
      return {
        ok: true,
        summary: plan.summary,
        warnings: plan.warnings,
        data: {
          operationId: frame.target.operationId,
          planHash: plan.planHash,
          summary: plan.summary,
          targets: plan.operations.flatMap((operation) => {
            if (typeof operation !== 'object' || operation === null || Array.isArray(operation))
              return []
            const record = operation as Record<string, JsonValue>
            const sheet = typeof record.sheetId === 'string' ? record.sheetId : 'workbook'
            const address =
              typeof record.address === 'string'
                ? record.address
                : typeof record.range === 'string'
                  ? record.range
                  : String(record.op ?? 'change')
            return [`${sheet}!${address}`]
          }),
        },
      }
    }
    if (frame.command === 'apply_ops') {
      const plan = proposals.get(frame.target.operationId)
      if (
        plan === undefined ||
        frame.approval === undefined ||
        frame.approval.planHash !== plan.planHash
      ) {
        return failure('APPROVAL_INVALID', 'apply request is not bound to a proposed plan')
      }
      approvals.set(frame.approval.id, plan.planHash)
      try {
        const snapshot = proposalSnapshots.get(frame.target.operationId)
        if (
          snapshot !== undefined &&
          (adapter as EditorAdapter & { saveSnapshot?(): string }).saveSnapshot?.() !== snapshot
        ) {
          return failure(
            'STALE_CONTENT',
            'The workbook changed after this plan was prepared; propose it again.',
          )
        }
        return await adapter.apply({ ...plan, approvalId: frame.approval.id } as ApprovedEditPlan)
      } finally {
        approvals.delete(frame.approval.id)
        proposals.delete(frame.target.operationId)
        proposalSnapshots.delete(frame.target.operationId)
      }
    }
    return failure(
      'UNAVAILABLE_IN_WEB',
      `the command ${frame.command} is unavailable in Web Sheets`,
    )
  }

  const replay = (frame: EditorRequestFrame, fingerprint: string): AgentToolResult | undefined => {
    if (options.workingCopy) return undefined // Host ledger is authoritative across pages and eviction.
    if (frame.command.startsWith('propose_')) return undefined
    const record = journal.read(frame.target.operationId)
    if (!record) return undefined
    return record.fingerprint === fingerprint
      ? record.result
      : failure('OPERATION_ID_COLLISION', 'operation id is bound to different editor arguments')
  }
  const remember = (
    frame: EditorRequestFrame,
    result: AgentToolResult,
    fingerprint: string,
  ): void => {
    if (!frame.command.startsWith('propose_'))
      journal.write(frame.target.operationId, {
        fingerprint,
        result,
        ...(receipts.get(frame.target.operationId)
          ? { persistence: receipts.get(frame.target.operationId)! }
          : {}),
      })
  }
  const releaseProposal = (operationId: string): void => {
    saveProposals.delete(operationId)
    proposals.delete(operationId)
    proposalSnapshots.delete(operationId)

    releasedProposals.set(operationId, true)
  }
  const handleRequest = async (frame: EditorRequestFrame): Promise<void> => {
    if (disposed) return
    const fingerprint = await editorRequestFingerprint(
      frame,
      options.workingCopy?.state()?.documentEpoch,
    )
    if (disposed) return
    const terminal = !frame.command.startsWith('propose_')
    const running = terminal ? terminalResults.get(frame.target.operationId) : undefined
    if (running) {
      if (running.fingerprint !== fingerprint) {
        deliverResult(
          frame,
          failure('OPERATION_ID_COLLISION', 'operation id is bound to different editor arguments'),
        )
      } else {
        void running.result.then((result) => deliverResult(frame, result))
      }
      return
    }
    const replayed = replay(frame, fingerprint)
    if (replayed !== undefined) {
      deliverResult(frame, replayed)
      return
    }
    if (releasedProposals.has(frame.target.operationId)) {
      deliverResult(frame, failure('APPROVAL_INVALID', 'the proposal was released'))
      return
    }
    // Schedule execution after the shared promise is registered, including synchronous failures.
    const work = async () => {
      let result: AgentToolResult
      try {
        const durable = options.workingCopy
        const mutation = frame.command === 'apply_ops' || frame.command === 'save_sheet'
        if (durable && mutation) {
          const previous = await durable.persistence.lookup(frame.target.operationId, fingerprint)
          if (previous.state === 'committed') {
            receipts.set(frame.target.operationId, previous.persistence)
            return previous.result
          }
          if (previous.state === 'pending')
            return failure(
              'WORKING_COPY_OUTCOME_UNKNOWN',
              'The previous operation is still pending; restore and query it before continuing.',
            )
        }
        const approvedSnapshot =
          frame.command === 'save_sheet'
            ? saveProposals.get(frame.target.operationId)?.snapshot
            : undefined
        result = await execute(frame)
        if (durable && mutation && result.ok) {
          const release = durable.lock?.() ?? (() => {})
          try {
            if (
              approvedSnapshot !== undefined &&
              (adapter as EditorAdapter & { saveSnapshot?(): string }).saveSnapshot?.() !==
                approvedSnapshot
            ) {
              throw new Error('STALE_CONTENT: the workbook changed after Save approval.')
            }
            const payload = await durable.capture()
            const receipt = await durable.persistence.checkpoint(frame, result, payload)
            receipts.set(frame.target.operationId, receipt)
            durable.committed(receipt)
          } finally {
            release()
          }
          if (frame.command === 'save_sheet') {
            try {
              await durable.afterSave?.()
            } catch {
              result = {
                ...result,
                warnings: [
                  ...result.warnings,
                  {
                    code: 'SAVED_RELOAD_FAILED',
                    message: 'The workbook was saved, but reopening failed. Reload to continue.',
                  },
                ],
              }
            }
          }
        }
        if (
          frame.command.startsWith('propose_') &&
          (disposed || releasedProposals.has(frame.target.operationId))
        ) {
          saveProposals.delete(frame.target.operationId)
          proposals.delete(frame.target.operationId)

          result = failure('APPROVAL_INVALID', 'the proposal was released')
        }
      } catch (error) {
        options.workingCopy?.failed?.()
        result = failure(
          options.workingCopy && (frame.command === 'apply_ops' || frame.command === 'save_sheet')
            ? 'WORKING_COPY_OUTCOME_UNKNOWN'
            : 'EDITOR_REQUEST_FAILED',
          error instanceof Error ? error.message : String(error),
        )
      }
      try {
        remember(frame, result, fingerprint)
      } catch {
        /* The in-memory result remains authoritative if storage is unavailable. */
      }
      return result
    }
    const resultPromise = options.workingCopy
      ? options.workingCopy.lane.run(work)
      : Promise.resolve().then(work)
    if (terminal)
      terminalResults.set(frame.target.operationId, {
        fingerprint,
        result: resultPromise,
      })
    void resultPromise.then((result) => {
      if (terminalResults.get(frame.target.operationId)?.result === resultPromise)
        terminalResults.delete(frame.target.operationId)
      deliverResult(frame, result)
    })
  }
  const unsubscribe = options.client.onFrame((frame) => {
    if (disposed) return
    if (frame.type === 'agent:event' && frame.event.type === 'editor:proposal-released') {
      const data = frame.event.data
      if (
        data &&
        typeof data === 'object' &&
        !Array.isArray(data) &&
        typeof data.operationId === 'string'
      )
        releaseProposal(data.operationId)
      return
    }
    if (frame.type === 'editor:request')
      requestQueue = requestQueue
        .then(() => handleRequest(frame))
        .catch((error: unknown) =>
          deliverResult(
            frame,
            failure(
              'EDITOR_REQUEST_FAILED',
              error instanceof Error ? error.message : String(error),
            ),
          ),
        )
  })

  return {
    agentApi: createAgentApi(options.client),
    attachEditor(nextAdapter) {
      adapter = nextAdapter
    },
    client() {
      return {
        clientId: options.client.clientId,
        attached:
          options.client.state === 'ready' && (!options.workingCopy || registration.attached),
      }
    },
    consumeApproval(approvalId, planHash) {
      if (approvals.get(approvalId) !== planHash) return false
      approvals.delete(approvalId)
      return true
    },
    updateRevision(revision) {
      registration.updateRevision(revision)
    },
    setHydrated(state) {
      registration.setHydrated(state)
    },
    dispose() {
      disposed = true
      releasedProposals.clear()
      terminalResults.clear()
      receipts.clear()
      journal.clearMemory()
      approvals.clear()
      proposals.clear()
      proposalSnapshots.clear()
      saveProposals.clear()
      adapter = undefined
      unsubscribe()
      registration.dispose()
    },
  }
}
