import {
  PROTOCOL_VERSION,
  type AgentToolResult,
  type ClientId,
  type DocumentId,
  type EditorRequestFrame,
  type JsonValue,
  type Revision,
} from '@nexusdesk/protocol'
import {
  createAgentApi,
  registerEditor,
  type AgentApi,
  type NexusClient,
} from '@nexusdesk/web-client'

export interface PdfEditPlan {
  planHash: string
  summary: string
  targets: string[]
  operations: JsonValue[]
}

export interface PdfEditorAdapter {
  read(arguments_: Record<string, JsonValue>): Promise<AgentToolResult>
  propose(operations: JsonValue[]): Promise<Omit<PdfEditPlan, 'operations'>>
  apply(plan: PdfEditPlan & { approvalId: string }): Promise<AgentToolResult>
  save(approvalId: string): Promise<AgentToolResult>
}

export interface PdfBrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: PdfEditorAdapter): () => void
  client(): { clientId: ClientId | undefined; attached: boolean }
  consumeApproval(approvalId: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  dispose(): void
}

export interface PdfBrowserAgentBridgeOptions {
  client: NexusClient
  documentId: DocumentId
  revision: Revision
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

interface JournalRecord {
  fingerprint: string
  result: AgentToolResult
}

function failure(code: string, message: string): AgentToolResult {
  return { ok: false, summary: message, warnings: [{ code, message }] }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function requestFingerprint(frame: EditorRequestFrame): string {
  return canonical({
    documentId: frame.target.documentId,
    editorType: frame.target.editorType,
    command: frame.command,
    arguments: frame.arguments,
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
  const proposals = new Map<string, PdfEditPlan>()
  const storage = options.storage ?? defaultStorage()
  const registration = registerEditor(options.client, {
    documentId: options.documentId,
    editorType: 'pdf',
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
  const deliver = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    try {
      sendResult(frame, result)
    } catch {
      // The result journal is replayed when the editor reconnects.
    }
  }

  const execute = async (frame: EditorRequestFrame): Promise<AgentToolResult> => {
    if (adapter === undefined) return failure('EDITOR_NOT_READY', 'the PDF editor is not ready')
    if (frame.command === 'read_pdf') {
      return adapter.read(frame.arguments as Record<string, JsonValue>)
    }
    if (frame.command === 'propose_ops') {
      const args = frame.arguments as { ops?: unknown }
      if (!Array.isArray(args.ops)) return failure('INVALID_REQUEST', 'PDF operations must be an array')
      const operations = args.ops as JsonValue[]
      const proposed = await adapter.propose(operations)
      const plan: PdfEditPlan = { ...proposed, operations }
      proposals.set(frame.target.operationId, plan)
      return {
        ok: true,
        summary: plan.summary,
        warnings: [],
        data: {
          operationId: frame.target.operationId,
          planHash: plan.planHash,
          summary: plan.summary,
          targets: plan.targets,
        },
      }
    }
    if (frame.command === 'apply_ops') {
      const plan = proposals.get(frame.target.operationId)
      if (plan === undefined || frame.approval === undefined || frame.approval.planHash !== plan.planHash) {
        return failure('APPROVAL_INVALID', 'apply request is not bound to a proposed PDF plan')
      }
      approvals.set(frame.approval.id, plan.planHash)
      try {
        return await adapter.apply({ ...plan, approvalId: frame.approval.id })
      } finally {
        approvals.delete(frame.approval.id)
        proposals.delete(frame.target.operationId)
      }
    }
    if (frame.command === 'save_pdf') {
      if (frame.approval === undefined || frame.approval.planHash !== 'save-current-pdf-in-place') {
        return failure('APPROVAL_INVALID', 'save request is not bound to the current PDF')
      }
      approvals.set(frame.approval.id, frame.approval.planHash)
      try {
        return await adapter.save(frame.approval.id)
      } finally {
        approvals.delete(frame.approval.id)
      }
    }
    return failure('UNAVAILABLE_IN_WEB', `the command ${frame.command} is unavailable in Web PDF`)
  }

  const journalKey = (operationId: string): string =>
    `nexusdesk:editor-result:${options.documentId}:${operationId}`
  const replay = (frame: EditorRequestFrame): AgentToolResult | undefined => {
    if (storage === undefined || frame.command === 'propose_ops') return undefined
    const raw = storage.getItem(journalKey(frame.target.operationId))
    if (raw === null) return undefined
    try {
      const record = JSON.parse(raw) as JournalRecord
      if (record.fingerprint !== requestFingerprint(frame)) {
        return failure('OPERATION_ID_COLLISION', 'operation id is bound to different PDF arguments')
      }
      return record.result
    } catch {
      storage.removeItem(journalKey(frame.target.operationId))
      return undefined
    }
  }
  const remember = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    if (storage === undefined || frame.command === 'propose_ops') return
    storage.setItem(journalKey(frame.target.operationId), JSON.stringify({
      fingerprint: requestFingerprint(frame), result,
    } satisfies JournalRecord))
  }
  const unsubscribe = options.client.onFrame((frame) => {
    if (frame.type !== 'editor:request') return
    const replayed = replay(frame)
    if (replayed !== undefined) return deliver(frame, replayed)
    void (async () => {
      let result: AgentToolResult
      try {
        result = await execute(frame)
      } catch (error: unknown) {
        result = failure('EDITOR_REQUEST_FAILED', errorMessage(error))
      }
      remember(frame, result)
      deliver(frame, result)
    })()
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
      approvals.clear()
      proposals.clear()
      adapter = undefined
      unsubscribe()
      registration.dispose()
    },
  }
}
