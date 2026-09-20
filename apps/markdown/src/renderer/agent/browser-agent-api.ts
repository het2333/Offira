import { BoundedEditorCache, createEditorResultJournal } from '@nexusdesk/web-client'
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

export interface MarkdownBrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: EditorAdapter): () => void
  client(): { clientId: import('@nexusdesk/protocol').ClientId | undefined; attached: boolean }
  consumeApproval(approvalId: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  dispose(): void
}

export interface MarkdownBrowserAgentBridgeOptions {
  client: NexusClient
  documentId: import('@nexusdesk/protocol').DocumentId
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

function fingerprint(frame: EditorRequestFrame): string {
  return canonical({
    documentId: frame.target.documentId,
    editorType: frame.target.editorType,
    command: frame.command,
    arguments: frame.arguments,
    planHash: frame.approval?.planHash,
  })
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

/** Browser-side protocol bridge with replay-safe operation result journaling. */
export function createMarkdownBrowserAgentBridge(
  options: MarkdownBrowserAgentBridgeOptions,
): MarkdownBrowserAgentBridge {
  let adapter: EditorAdapter | undefined
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
    editorType: 'markdown',
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
      // The journal is replayed when the authenticated editor reconnects.
    }
  }
  const execute = async (frame: EditorRequestFrame): Promise<AgentToolResult> => {
    if (!adapter) return failure('EDITOR_NOT_READY', 'the Markdown editor is not ready')
    if (frame.command === 'read_markdown')
      return adapter.read({
        documentId: frame.target.documentId,
        command: frame.command,
        arguments: frame.arguments,
      })
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
        canonical({ target: frame.target, command: 'save_markdown', snapshotHash }),
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
    if (frame.command === 'save_markdown') {
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
          targets: plan.operations.map((operation) =>
            typeof operation === 'object' && operation !== null && !Array.isArray(operation)
              ? String((operation as Record<string, unknown>).op ?? 'change')
              : 'change',
          ),
        },
      }
    }
    if (frame.command === 'apply_ops') {
      const plan = proposals.get(frame.target.operationId)
      if (!plan || !frame.approval || frame.approval.planHash !== plan.planHash)
        return failure('APPROVAL_INVALID', 'apply request is not bound to a proposed plan')
      approvals.set(frame.approval.id, plan.planHash)
      try {
        return await adapter.apply({ ...plan, approvalId: frame.approval.id })
      } finally {
        approvals.delete(frame.approval.id)
        proposals.delete(frame.target.operationId)
      }
    }
    return failure(
      'UNAVAILABLE_IN_WEB',
      `the command ${frame.command} is unavailable in Web Markdown`,
    )
  }
  const unsubscribe = options.client.onFrame((frame) => {
    if (frame.type !== 'editor:request') return
    const terminal = !frame.command.startsWith('propose_')
    const running = terminal ? terminalResults.get(frame.target.operationId) : undefined
    if (running) {
      if (running.fingerprint !== fingerprint(frame)) {
        send(
          frame,
          failure('OPERATION_ID_COLLISION', 'operation id is bound to different editor arguments'),
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
        remembered.fingerprint === fingerprint(frame)
          ? remembered.result
          : failure(
              'OPERATION_ID_COLLISION',
              'operation id is bound to different editor arguments',
            ),
      )
      return
    }
    // Schedule execution after the shared promise is registered, including synchronous failures.
    const resultPromise = Promise.resolve().then(async () => {
      let result: AgentToolResult
      try {
        result = await execute(frame)
      } catch (error) {
        result = failure(
          'EDITOR_REQUEST_FAILED',
          error instanceof Error ? error.message : String(error),
        )
      }
      try {
        if (terminal)
          journal.write(frame.target.operationId, { fingerprint: fingerprint(frame), result })
      } catch {
        /* The in-memory result remains authoritative if storage is unavailable. */
      }
      return result
    })
    if (terminal)
      terminalResults.set(frame.target.operationId, {
        fingerprint: fingerprint(frame),
        result: resultPromise,
      })
    void resultPromise.then((result) => {
      if (terminalResults.get(frame.target.operationId)?.result === resultPromise)
        terminalResults.delete(frame.target.operationId)
      send(frame, result)
    })
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
    consumeApproval(id, planHash) {
      if (approvals.get(id) !== planHash) return false
      approvals.delete(id)
      return true
    },
    updateRevision(revision) {
      registration.updateRevision(revision)
    },
    dispose() {
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
