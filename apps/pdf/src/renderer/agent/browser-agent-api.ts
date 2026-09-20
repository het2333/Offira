import {
  PROTOCOL_VERSION,
  PdfPayloadTooLargeError,
  type AgentToolResult,
  type ClientId,
  type DocumentId,
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
  type NexusClient,
  BoundedEditorCache,
  createEditorResultJournal,
  editorRequestFingerprint,
  createWorkingCopyMutationLane,
  type BrowserWorkingCopyPayload,
  type BrowserWorkingCopyPersistence,
} from '@nexusdesk/web-client'

export interface PdfEditPlan {
  planHash: string
  /** Fingerprint of the renderer's pending work when the plan was generated. */
  snapshotHash: string
  summary: string
  targets: string[]
  operations: JsonValue[]
}

export interface PdfEditorAdapter {
  read(arguments_: Record<string, JsonValue>): Promise<AgentToolResult>
  snapshot(): Promise<string>
  propose(
    operations: JsonValue[],
    snapshotHash: string,
  ): Promise<Omit<PdfEditPlan, 'operations' | 'snapshotHash'> & { operations?: JsonValue[] }>
  proposeSave(): Promise<Omit<PdfEditPlan, 'operations'>>
  apply(plan: PdfEditPlan & { approvalId: string }): Promise<PdfMutationResult>
  save(plan: PdfEditPlan & { approvalId: string }): Promise<PdfMutationResult>
  persisted?(receipt: PersistenceReference): Promise<void>
  restoreWorkingCopy?(): Promise<void>
}

export type PdfMutationResult = AgentToolResult & { workingCopy?: BrowserWorkingCopyPayload }

export interface PdfBrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: PdfEditorAdapter): () => void
  client(): { clientId: ClientId | undefined; attached: boolean }
  consumeApproval(approvalId: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  setHydrated(state: WorkingCopyBootstrap | null): void
  dispose(): void
}

export interface PdfBrowserAgentBridgeOptions {
  client: NexusClient
  documentId: DocumentId
  revision: Revision
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  workingCopy?: {
    state(): WorkingCopyBootstrap | null
    persistence: BrowserWorkingCopyPersistence
    didPersist?(receipt: PersistenceReference): void
    run?<T>(task: () => Promise<T>): Promise<T>
  }
}

interface JournalRecord {
  fingerprint: string
  result: AgentToolResult
  persistence?: PersistenceReference
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

function requestFingerprint(frame: EditorRequestFrame): string {
  return canonical({
    documentId: frame.target.documentId,
    editorType: frame.target.editorType,
    command: frame.command,
    arguments: frame.arguments,
    ...(frame.approval === undefined ? {} : { planHash: frame.approval.planHash }),
  })
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'the PDF editor request failed'
}

/** Browser-side replay and exact-approval boundary for PDF Harness commands. */
export function createPdfBrowserAgentBridge(
  options: PdfBrowserAgentBridgeOptions,
): PdfBrowserAgentBridge {
  let adapter: PdfEditorAdapter | undefined
  const approvals = new Map<string, string>()
  const proposals = new BoundedEditorCache<string, PdfEditPlan>()
  const saveProposals = new BoundedEditorCache<string, PdfEditPlan>()
  const inFlight = new Map<string, { fingerprint: string; result: Promise<JournalRecord> }>()
  const uncertain = new Map<string, string>()
  const storage = options.storage ?? defaultStorage()
  const journal = createEditorResultJournal(storage, options.documentId, {
    requirePersistence: !!options.workingCopy,
  })
  const run = options.workingCopy?.run ?? createWorkingCopyMutationLane().run
  const registration = registerEditor(options.client, {
    documentId: options.documentId,
    editorType: 'pdf',
    revision: options.revision,
    workingCopy: !!options.workingCopy,
  })

  const sendResult = (frame: EditorRequestFrame, record: JournalRecord): void => {
    options.client.send({
      type: 'editor:result',
      protocolVersion: PROTOCOL_VERSION,
      id: frame.id,
      target: frame.target,
      result: record.result,
      ...(record.persistence ? { persistence: record.persistence } : {}),
    })
  }
  const deliver = (frame: EditorRequestFrame, record: JournalRecord): void => {
    try {
      sendResult(frame, record)
    } catch {
      // The result journal is replayed when the editor reconnects.
    }
  }

  const execute = async (frame: EditorRequestFrame): Promise<PdfMutationResult> => {
    const editor = adapter
    if (editor === undefined) return failure('EDITOR_NOT_READY', 'the PDF editor is not ready')
    if (frame.command === 'read_pdf') {
      return editor.read(frame.arguments as Record<string, JsonValue>)
    }
    if (frame.command === 'propose_ops') {
      const args = frame.arguments as { ops?: unknown }
      if (!Array.isArray(args.ops))
        return failure('INVALID_REQUEST', 'PDF operations must be an array')
      const operations = args.ops as JsonValue[]
      const snapshotHash = await editor.snapshot()
      const proposed = await editor.propose(operations, snapshotHash)
      const plan: PdfEditPlan = {
        ...proposed,
        snapshotHash,
        operations: proposed.operations ?? operations,
      }
      proposals.set(frame.target.operationId, plan)
      return {
        ok: true,
        summary: plan.summary,
        warnings: [],
        data: {
          operationId: frame.target.operationId,
          planHash: plan.planHash,
          snapshotHash: plan.snapshotHash,
          summary: plan.summary,
          targets: plan.targets,
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
        return failure('APPROVAL_INVALID', 'apply request is not bound to a proposed PDF plan')
      }
      if ((await editor.snapshot()) !== plan.snapshotHash) {
        proposals.delete(frame.target.operationId)
        return failure(
          'STALE_PLAN',
          'the PDF changed after this operation was proposed; propose it again',
        )
      }
      approvals.set(frame.approval.id, plan.planHash)
      try {
        return await editor.apply({ ...plan, approvalId: frame.approval.id })
      } finally {
        approvals.delete(frame.approval.id)
        proposals.delete(frame.target.operationId)
      }
    }
    if (frame.command === 'propose_save') {
      const plan: PdfEditPlan = { ...(await editor.proposeSave()), operations: [] }
      saveProposals.set(frame.target.operationId, plan)
      return {
        ok: true,
        summary: plan.summary,
        warnings: [],
        data: {
          operationId: frame.target.operationId,
          planHash: plan.planHash,
          snapshotHash: plan.snapshotHash,
          summary: plan.summary,
          targets: plan.targets,
        },
      }
    }
    if (frame.command === 'save_pdf') {
      const plan = saveProposals.get(frame.target.operationId)
      if (
        plan === undefined ||
        frame.approval === undefined ||
        frame.approval.planHash !== plan.planHash
      ) {
        return failure('APPROVAL_INVALID', 'save request is not bound to a proposed PDF save')
      }
      if ((await editor.snapshot()) !== plan.snapshotHash) {
        saveProposals.delete(frame.target.operationId)
        return failure(
          'STALE_PLAN',
          'the PDF changed after this save was proposed; propose it again',
        )
      }
      approvals.set(frame.approval.id, plan.planHash)
      try {
        return await editor.save({ ...plan, approvalId: frame.approval.id })
      } finally {
        approvals.delete(frame.approval.id)
        saveProposals.delete(frame.target.operationId)
      }
    }
    return failure('UNAVAILABLE_IN_WEB', `the command ${frame.command} is unavailable in Web PDF`)
  }

  const unsubscribe = options.client.onFrame((frame) => {
    if (frame.type !== 'editor:request') return
    const mutation = frame.command === 'apply_ops' || frame.command === 'save_pdf'
    const running = mutation ? inFlight.get(frame.target.operationId) : undefined
    if (running) {
      if (running.fingerprint !== requestFingerprint(frame)) {
        deliver(frame, {
          fingerprint: requestFingerprint(frame),
          result: failure(
            'OPERATION_ID_COLLISION',
            'operation id is bound to different PDF arguments',
          ),
        })
      } else {
        void running.result.then((result) => deliver(frame, result))
      }
      return
    }
    // The microtask starts only after the in-flight slot exists, including storage/lookup errors.
    const resultPromise = Promise.resolve().then(() =>
      run(async (): Promise<JournalRecord> => {
        const fingerprint = await editorRequestFingerprint(
          frame,
          options.workingCopy?.state()?.documentEpoch,
        )
        try {
          if (mutation) {
            const prior = journal.read(frame.target.operationId)
            if (prior && prior.fingerprint !== fingerprint)
              return {
                fingerprint,
                result: failure(
                  'OPERATION_ID_COLLISION',
                  'operation id is bound to different PDF arguments',
                ),
              }
            if (options.workingCopy) {
              const recovered = await options.workingCopy.persistence.lookup(
                frame.target.operationId,
                fingerprint,
              )
              if (recovered.state === 'committed') {
                if (uncertain.delete(frame.target.operationId)) {
                  options.workingCopy.didPersist?.(recovered.persistence)
                  if (recovered.persistence.dirty)
                    registration.setHydrated(options.workingCopy.state())
                  try {
                    await adapter?.persisted?.(recovered.persistence)
                  } catch {
                    recovered.result = {
                      ...recovered.result,
                      warnings: [
                        ...recovered.result.warnings,
                        {
                          code: 'PDF_RELOAD_FAILED',
                          message:
                            'PDF saved; reload failed. Refresh to restore the saved document.',
                        },
                      ],
                    }
                    registration.setHydrated(null)
                  }
                }
                return { fingerprint, result: recovered.result, persistence: recovered.persistence }
              }
              if (uncertain.size)
                return {
                  fingerprint,
                  result: failure(
                    'WORKING_COPY_OUTCOME_UNKNOWN',
                    'Restore and query this PDF operation before continuing.',
                  ),
                }
            } else if (prior) return prior
          }
          const executingAdapter = adapter
          const { workingCopy, ...result } = await execute(frame)
          let persistence: PersistenceReference | undefined
          if (mutation && result.ok && options.workingCopy) {
            if (!workingCopy) throw Error('The PDF editor did not capture its applied post-state.')
            uncertain.set(frame.target.operationId, fingerprint)
            persistence = await options.workingCopy.persistence.checkpoint(
              frame,
              result,
              workingCopy,
            )
            uncertain.delete(frame.target.operationId)
            options.workingCopy.didPersist?.(persistence)
            if (persistence.dirty) registration.setHydrated(options.workingCopy.state())
            // A durable save stays successful even if the browser cannot reopen it.
            try {
              await executingAdapter?.persisted?.(persistence)
            } catch {
              result.warnings = [
                ...result.warnings,
                {
                  code: 'PDF_RELOAD_FAILED',
                  message: 'PDF saved; reload failed. Refresh to restore the saved document.',
                },
              ]
              registration.setHydrated(null)
            }
          }
          const record: JournalRecord = {
            fingerprint,
            result,
            ...(persistence ? { persistence } : {}),
          }
          if (mutation) journal.write(frame.target.operationId, record)
          return record
        } catch (error: unknown) {
          return {
            fingerprint,
            result: failure(
              error instanceof PdfPayloadTooLargeError
                ? error.code
                : typeof (error as { code?: unknown })?.code === 'string'
                  ? (error as { code: string }).code
                  : 'EDITOR_REQUEST_FAILED',
              errorMessage(error),
            ),
          }
        }
      }),
    )
    if (mutation)
      inFlight.set(frame.target.operationId, {
        fingerprint: requestFingerprint(frame),
        result: resultPromise,
      })
    void resultPromise.then((result) => {
      if (mutation) inFlight.delete(frame.target.operationId)
      deliver(frame, result)
    })
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
      return {
        clientId: options.client.clientId,
        attached: adapter !== undefined && registration.attached,
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
      approvals.clear()
      proposals.clear()
      saveProposals.clear()
      adapter = undefined
      journal.clearMemory()
      unsubscribe()
      registration.dispose()
    },
  }
}
