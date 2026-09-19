import {
  PROTOCOL_VERSION,
  type AgentToolResult,
  type ApprovedEditPlan,
  type ClientId,
  type DocumentId,
  type EditorAdapter,
  type EditorRequestFrame,
  type EditRequest,
  type EditPlan,
  type Revision,
} from '@nexusdesk/protocol'
import { createAgentApi, registerEditor, type AgentApi, type NexusClient } from '@nexusdesk/web-client'

export interface SlidesBrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: EditorAdapter): () => void
  client(): { clientId: ClientId | undefined; attached: boolean }
  consumeApproval(approvalId: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  dispose(): void
}

export interface SlidesBrowserAgentBridgeOptions {
  client: NexusClient
  documentId: DocumentId
  revision: Revision
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

interface JournalRecord { fingerprint: string; result: AgentToolResult }

interface SaveProposal {
  planHash: string
  contentVersion: number
  summary: string
  targets: string[]
  warnings: AgentToolResult['warnings']
}

type SaveProposalAdapter = EditorAdapter & {
  proposeSave?(request: EditRequest): Promise<SaveProposal>
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
  return canonical({ documentId: frame.target.documentId, editorType: frame.target.editorType, command: frame.command, arguments: frame.arguments })
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try { return globalThis.sessionStorage } catch { return undefined }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'the editor request failed'
}

function contentVersion(argumentsValue: unknown): number | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)) return undefined
  const value = (argumentsValue as Record<string, unknown>).contentVersion
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function createSlidesBrowserAgentBridge(options: SlidesBrowserAgentBridgeOptions): SlidesBrowserAgentBridge {
  let adapter: EditorAdapter | undefined
  const approvals = new Map<string, string>()
  const proposals = new Map<string, EditPlan>()
  const saveProposals = new Map<string, SaveProposal>()
  const storage = options.storage ?? defaultStorage()
  const registration = registerEditor(options.client, { documentId: options.documentId, editorType: 'slides', revision: options.revision })
  const sendResult = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    options.client.send({ type: 'editor:result', protocolVersion: PROTOCOL_VERSION, id: frame.id, target: frame.target, result })
  }
  const deliverResult = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    try { sendResult(frame, result) } catch { /* journal replays after reconnect */ }
  }
  const execute = async (frame: EditorRequestFrame): Promise<AgentToolResult> => {
    if (adapter === undefined) return failure('EDITOR_NOT_READY', 'the presentation editor is not ready')
    if (frame.command === 'read_presentation') return adapter.read({ documentId: frame.target.documentId, command: frame.command, arguments: frame.arguments })
    if (frame.command === 'propose_save') {
      const saveAdapter = adapter as SaveProposalAdapter
      if (saveAdapter.proposeSave === undefined) {
        return failure('UNAVAILABLE_IN_WEB', 'the presentation editor cannot prepare an in-place save')
      }
      const plan = await saveAdapter.proposeSave({
        ...frame.target,
        command: 'save_presentation',
        arguments: {},
      })
      saveProposals.set(frame.target.operationId, plan)
      return {
        ok: true,
        summary: plan.summary,
        warnings: plan.warnings,
        data: {
          operationId: frame.target.operationId,
          planHash: plan.planHash,
          summary: plan.summary,
          targets: plan.targets,
          contentVersion: plan.contentVersion,
        },
      }
    }
    if (frame.command === 'save_presentation') {
      const expectedContentVersion = contentVersion(frame.arguments)
      if (expectedContentVersion === undefined) {
        return failure('SAVE_VERSION_REQUIRED', 'save_presentation must name the in-memory presentation version it was approved to save')
      }
      const plan = saveProposals.get(frame.target.operationId)
      if (
        plan === undefined ||
        frame.approval === undefined ||
        frame.approval.planHash !== plan.planHash ||
        expectedContentVersion !== plan.contentVersion
      ) {
        return failure('APPROVAL_INVALID', 'save request is not bound to a proposed presentation version')
      }
      const save = adapter.save as (documentId: DocumentId, expectedContentVersion?: number) => Promise<AgentToolResult>
      try {
        return await save(frame.target.documentId, expectedContentVersion)
      } finally {
        saveProposals.delete(frame.target.operationId)
      }
    }
    if (frame.command === 'propose_ops') {
      const plan = await adapter.propose({ ...frame.target, command: 'apply_ops', arguments: frame.arguments })
      proposals.set(frame.target.operationId, plan)
      return {
        ok: true, summary: plan.summary, warnings: plan.warnings,
        data: {
          operationId: frame.target.operationId, planHash: plan.planHash, summary: plan.summary,
          targets: plan.operations.flatMap((operation) => typeof operation === 'object' && operation !== null && !Array.isArray(operation) ? [String((operation as Record<string, unknown>).op ?? 'change')] : []),
        },
      }
    }
    if (frame.command === 'apply_ops') {
      const plan = proposals.get(frame.target.operationId)
      if (plan === undefined || frame.approval === undefined || frame.approval.planHash !== plan.planHash) return failure('APPROVAL_INVALID', 'apply request is not bound to a proposed plan')
      approvals.set(frame.approval.id, plan.planHash)
      try { return await adapter.apply({ ...plan, approvalId: frame.approval.id } as ApprovedEditPlan) }
      finally { approvals.delete(frame.approval.id); proposals.delete(frame.target.operationId) }
    }
    return failure('UNAVAILABLE_IN_WEB', `the command ${frame.command} is unavailable in Web Slides`)
  }
  const journalKey = (operationId: string): string => `nexusdesk:editor-result:${options.documentId}:${operationId}`
  const replay = (frame: EditorRequestFrame): AgentToolResult | undefined => {
    if (storage === undefined || frame.command === 'propose_ops' || frame.command === 'propose_save') return undefined
    const raw = storage.getItem(journalKey(frame.target.operationId))
    if (raw === null) return undefined
    try {
      const record = JSON.parse(raw) as JournalRecord
      if (record.fingerprint !== requestFingerprint(frame)) return failure('OPERATION_ID_COLLISION', 'operation id is bound to different editor arguments')
      return record.result
    } catch { storage.removeItem(journalKey(frame.target.operationId)); return undefined }
  }
  const remember = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    if (storage === undefined || frame.command === 'propose_ops' || frame.command === 'propose_save') return
    storage.setItem(journalKey(frame.target.operationId), JSON.stringify({ fingerprint: requestFingerprint(frame), result } satisfies JournalRecord))
  }
  const unsubscribe = options.client.onFrame((frame) => {
    if (frame.type !== 'editor:request') return
    const replayed = replay(frame)
    if (replayed !== undefined) { deliverResult(frame, replayed); return }
    void (async () => {
      let result: AgentToolResult
      try { result = await execute(frame) } catch (error) { result = failure('EDITOR_REQUEST_FAILED', errorMessage(error)) }
      remember(frame, result)
      deliverResult(frame, result)
    })()
  })
  return {
    agentApi: createAgentApi(options.client),
    attachEditor(nextAdapter) { adapter = nextAdapter; return () => { if (adapter === nextAdapter) adapter = undefined } },
    client() { return { clientId: options.client.clientId, attached: options.client.state === 'ready' } },
    consumeApproval(approvalId, planHash) { if (approvals.get(approvalId) !== planHash) return false; approvals.delete(approvalId); return true },
    updateRevision(revision) { registration.updateRevision(revision) },
    dispose() { approvals.clear(); proposals.clear(); saveProposals.clear(); adapter = undefined; unsubscribe(); registration.dispose() },
  }
}
