import {
  BoundedEditorCache,
  createEditorResultJournal,
  editorRequestFingerprint,
} from '@nexusdesk/web-client'
import {
  PROTOCOL_VERSION,
  type AgentToolResult,
  type EditPlan,
  type EditorAdapter,
  type EditorRequestFrame,
  type Revision,
} from '@nexusdesk/protocol'
import {
  createAgentApi,
  registerEditor,
  type AgentApi,
  type NexusClient,
} from '@nexusdesk/web-client'

export interface HtmlBrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: EditorAdapter): () => void
  client(): { clientId: import('@nexusdesk/protocol').ClientId | undefined; attached: boolean }
  consumeApproval(id: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  dispose(): void
}
export interface HtmlBrowserAgentBridgeOptions {
  client: NexusClient
  documentId: import('@nexusdesk/protocol').DocumentId
  revision: Revision
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}
const fail = (code: string, message: string): AgentToolResult => ({
  ok: false,
  summary: message,
  warnings: [{ code, message }],
})
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

/** Replay-safe Host bridge for the existing HTML editor adapter. */
export function createHtmlBrowserAgentBridge(
  options: HtmlBrowserAgentBridgeOptions,
): HtmlBrowserAgentBridge {
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
    editorType: 'html',
    revision: options.revision,
  })
  const send = (frame: EditorRequestFrame, result: AgentToolResult) => {
    try {
      options.client.send({
        type: 'editor:result',
        protocolVersion: PROTOCOL_VERSION,
        id: frame.id,
        target: frame.target,
        result,
      })
    } catch {
      /* reconnect replays journal */
    }
  }
  const execute = async (frame: EditorRequestFrame): Promise<AgentToolResult> => {
    if (!adapter) return fail('EDITOR_NOT_READY', 'the HTML editor is not ready')
    if (frame.command === 'read_html')
      return adapter.read({
        documentId: frame.target.documentId,
        command: frame.command,
        arguments: frame.arguments,
      })
    if (frame.command === 'propose_save') {
      const saveAdapter = adapter as EditorAdapter & { saveSnapshot?(): string }
      if (!saveAdapter.saveSnapshot)
        return fail('SAVE_SNAPSHOT_UNAVAILABLE', 'the editor cannot prepare an exact save snapshot')
      const snapshot = saveAdapter.saveSnapshot()
      const digest = async (value: string): Promise<string> => {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
        return [...new Uint8Array(bytes)]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
      }
      const snapshotHash = await digest(snapshot)
      const planHash = await digest(
        canonical({ target: frame.target, command: 'save_html', snapshotHash }),
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
    if (frame.command === 'save_html') {
      const plan = saveProposals.get(frame.target.operationId)
      const args = frame.arguments as Record<string, unknown>
      if (
        !plan ||
        !frame.approval ||
        frame.approval.planHash !== plan.planHash ||
        args.snapshotHash !== plan.snapshotHash
      ) {
        return fail('APPROVAL_INVALID', 'save request is not bound to an exact proposed snapshot')
      }
      saveProposals.delete(frame.target.operationId)
      const saveAdapter = adapter as EditorAdapter & { saveSnapshot?(): string }
      if (saveAdapter !== plan.adapter || saveAdapter.saveSnapshot?.() !== plan.snapshot) {
        return fail(
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
          targets: plan.operations.map((op) =>
            typeof op === 'object' && op !== null && !Array.isArray(op)
              ? String((op as Record<string, unknown>).op ?? 'change')
              : 'change',
          ),
        },
      }
    }
    if (frame.command === 'apply_ops') {
      const plan = proposals.get(frame.target.operationId)
      if (!plan || !frame.approval || plan.planHash !== frame.approval.planHash)
        return fail('APPROVAL_INVALID', 'apply request is not bound to a proposed plan')
      approvals.set(frame.approval.id, plan.planHash)
      try {
        return await adapter.apply({ ...plan, approvalId: frame.approval.id })
      } finally {
        approvals.delete(frame.approval.id)
        proposals.delete(frame.target.operationId)
      }
    }
    return fail('UNAVAILABLE_IN_WEB', `the command ${frame.command} is unavailable in Web HTML`)
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
        send(
          frame,
          fail('OPERATION_ID_COLLISION', 'operation id is bound to different editor arguments'),
        )
      } else {
        void running.result.then((result) => send(frame, result))
      }
      return
    }
    const remembered = terminal ? journal.read(frame.target.operationId) : undefined
    if (remembered) {
      send(
        frame,
        remembered.fingerprint === fingerprint
          ? remembered.result
          : fail('OPERATION_ID_COLLISION', 'operation id is bound to different editor arguments'),
      )
      return
    }
    if (releasedProposals.has(frame.target.operationId)) {
      send(frame, fail('APPROVAL_INVALID', 'the proposal was released'))
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

          result = fail('APPROVAL_INVALID', 'the proposal was released')
        }
      } catch (error) {
        result = fail(
          'EDITOR_REQUEST_FAILED',
          error instanceof Error ? error.message : String(error),
        )
      }
      try {
        if (terminal) journal.write(frame.target.operationId, { fingerprint, result })
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
      send(frame, result)
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
          send(
            frame,
            fail('EDITOR_REQUEST_FAILED', error instanceof Error ? error.message : String(error)),
          ),
        )
  })

  return {
    agentApi: createAgentApi(options.client),
    attachEditor(next) {
      adapter = next
      return () => {
        if (adapter === next) adapter = undefined
      }
    },
    client: () => ({
      clientId: options.client.clientId,
      attached: options.client.state === 'ready',
    }),
    consumeApproval(id, hash) {
      if (approvals.get(id) !== hash) return false
      approvals.delete(id)
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
