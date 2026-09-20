import {
  BoundedEditorCache,
  createEditorResultJournal,
  editorRequestFingerprint,
} from '@nexusdesk/web-client'
import {
  PROTOCOL_VERSION,
  type AgentToolResult,
  type ApprovedEditPlan,
  type ClientId,
  type DocumentId,
  type EditorAdapter,
  type EditorRequestFrame,
  type EditPlan,
  type JsonValue,
  type Revision,
} from '@nexusdesk/protocol'
import {
  createAgentApi,
  registerEditor,
  type AgentApi,
  type NexusClient,
} from '@nexusdesk/web-client'

export interface DocsBrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: EditorAdapter): () => void
  client(): { clientId: ClientId | undefined; attached: boolean }
  consumeApproval(approvalId: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  dispose(): void
}

export interface DocsBrowserAgentBridgeOptions {
  client: NexusClient
  documentId: DocumentId
  revision: Revision
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
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

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

export function createDocsBrowserAgentBridge(
  options: DocsBrowserAgentBridgeOptions,
): DocsBrowserAgentBridge {
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
  const storage = options.storage ?? defaultStorage()
  const journal = createEditorResultJournal(storage, options.documentId)
  const registration = registerEditor(options.client, {
    documentId: options.documentId,
    editorType: 'docs',
    revision: options.revision,
  })

  const sendResult = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    options.client.send({
      type: 'editor:result',
      protocolVersion: PROTOCOL_VERSION,
      id: frame.id,
      target: frame.target,
      result,
    })
  }

  const deliverResult = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    try {
      sendResult(frame, result)
    } catch {
      // The journal remains authoritative and is replayed after reconnect.
    }
  }

  const execute = async (frame: EditorRequestFrame): Promise<AgentToolResult> => {
    if (adapter === undefined)
      return failure('EDITOR_NOT_READY', 'the document editor is not ready')
    if (frame.command === 'read_document') {
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
        canonical({ target: frame.target, command: 'save_document', snapshotHash }),
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
    if (frame.command === 'save_document') {
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
      return saveAdapter.save(frame.target.documentId)
    }
    if (frame.command === 'propose_ops') {
      const plan = await adapter.propose({
        ...frame.target,
        command: 'apply_ops',
        arguments: frame.arguments,
      })
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
            if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
              return []
            }
            const value = operation as Record<string, JsonValue>
            return [String(value.op ?? 'change')]
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
        return await adapter.apply({ ...plan, approvalId: frame.approval.id } as ApprovedEditPlan)
      } finally {
        approvals.delete(frame.approval.id)
        proposals.delete(frame.target.operationId)
      }
    }
    return failure('UNAVAILABLE_IN_WEB', `the command ${frame.command} is unavailable in Web Docs`)
  }

  const replay = (frame: EditorRequestFrame, fingerprint: string): AgentToolResult | undefined => {
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
      journal.write(frame.target.operationId, { fingerprint, result })
  }
  const releaseProposal = (operationId: string): void => {
    saveProposals.delete(operationId)
    proposals.delete(operationId)

    releasedProposals.set(operationId, true)
  }
  const handleRequest = async (frame: EditorRequestFrame): Promise<void> => {
    if (disposed) return
    const fingerprint = await editorRequestFingerprint(frame)
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
    const resultPromise = Promise.resolve().then(async () => {
      let result: AgentToolResult
      try {
        result = await execute(frame)
        if (
          frame.command.startsWith('propose_') &&
          (disposed || releasedProposals.has(frame.target.operationId))
        ) {
          saveProposals.delete(frame.target.operationId)
          proposals.delete(frame.target.operationId)

          result = failure('APPROVAL_INVALID', 'the proposal was released')
        }
      } catch (error) {
        result = failure(
          'EDITOR_REQUEST_FAILED',
          error instanceof Error ? error.message : String(error),
        )
      }
      try {
        remember(frame, result, fingerprint)
      } catch {
        /* The in-memory result remains authoritative if storage is unavailable. */
      }
      return result
    })
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
      return () => {
        if (adapter === nextAdapter) adapter = undefined
      }
    },
    client() {
      return { clientId: options.client.clientId, attached: options.client.state === 'ready' }
    },
    consumeApproval(approvalId, planHash) {
      if (approvals.get(approvalId) !== planHash) return false
      approvals.delete(approvalId)
      return true
    },
    updateRevision(revision) {
      registration.updateRevision(revision)
    },
    dispose() {
      disposed = true
      releasedProposals.clear()
      terminalResults.clear()
      journal.clearMemory()
      approvals.clear()
      proposals.clear()
      saveProposals.clear()
      adapter = undefined
      unsubscribe()
      registration.dispose()
    },
  }
}
