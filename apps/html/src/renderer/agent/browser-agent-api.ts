import { PROTOCOL_VERSION, type AgentToolResult, type EditPlan, type EditorAdapter, type EditorRequestFrame, type Revision } from '@nexusdesk/protocol'
import { createAgentApi, registerEditor, type AgentApi, type NexusClient } from '@nexusdesk/web-client'

export interface HtmlBrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: EditorAdapter): () => void
  client(): { clientId: import('@nexusdesk/protocol').ClientId | undefined; attached: boolean }
  consumeApproval(id: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  dispose(): void
}
export interface HtmlBrowserAgentBridgeOptions { client: NexusClient; documentId: import('@nexusdesk/protocol').DocumentId; revision: Revision; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }
interface JournalRecord { fingerprint: string; result: AgentToolResult }
const SAVE_PLAN_HASH = 'save-current-html-in-place'
const fail = (code: string, message: string): AgentToolResult => ({ ok: false, summary: message, warnings: [{ code, message }] })
function canonical(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}` }
function fingerprint(frame: EditorRequestFrame): string { return canonical({ documentId: frame.target.documentId, editorType: frame.target.editorType, command: frame.command, arguments: frame.arguments }) }
function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined { try { return globalThis.sessionStorage } catch { return undefined } }

/** Replay-safe Host bridge for the existing HTML editor adapter. */
export function createHtmlBrowserAgentBridge(options: HtmlBrowserAgentBridgeOptions): HtmlBrowserAgentBridge {
  let adapter: EditorAdapter | undefined
  const approvals = new Map<string, string>()
  const consumedSaveApprovals = new Set<string>()
  const proposals = new Map<string, EditPlan>()
  const storage = options.storage ?? defaultStorage()
  const registration = registerEditor(options.client, { documentId: options.documentId, editorType: 'html', revision: options.revision })
  const key = (operationId: string) => `nexusdesk:editor-result:${options.documentId}:${operationId}`
  const send = (frame: EditorRequestFrame, result: AgentToolResult) => { try { options.client.send({ type: 'editor:result', protocolVersion: PROTOCOL_VERSION, id: frame.id, target: frame.target, result }) } catch { /* reconnect replays journal */ } }
  const execute = async (frame: EditorRequestFrame): Promise<AgentToolResult> => {
    if (!adapter) return fail('EDITOR_NOT_READY', 'the HTML editor is not ready')
    if (frame.command === 'read_html') return adapter.read({ documentId: frame.target.documentId, command: frame.command, arguments: frame.arguments })
    if (frame.command === 'save_html') {
      const approval = frame.approval
      if (approval === undefined || approval.planHash !== SAVE_PLAN_HASH || consumedSaveApprovals.has(approval.id)) return fail('APPROVAL_INVALID', 'save request is not bound to an unused exact approval')
      consumedSaveApprovals.add(approval.id)
      return adapter.save(frame.target.documentId)
    }
    if (frame.command === 'propose_ops') { const plan = await adapter.propose({ ...frame.target, command: 'apply_ops', arguments: frame.arguments }); proposals.set(frame.target.operationId, plan); return { ok: true, summary: plan.summary, warnings: plan.warnings, data: { operationId: frame.target.operationId, planHash: plan.planHash, summary: plan.summary, targets: plan.operations.map((op) => typeof op === 'object' && op !== null && !Array.isArray(op) ? String((op as Record<string, unknown>).op ?? 'change') : 'change') } } }
    if (frame.command === 'apply_ops') { const plan = proposals.get(frame.target.operationId); if (!plan || !frame.approval || plan.planHash !== frame.approval.planHash) return fail('APPROVAL_INVALID', 'apply request is not bound to a proposed plan'); approvals.set(frame.approval.id, plan.planHash); try { return await adapter.apply({ ...plan, approvalId: frame.approval.id }) } finally { approvals.delete(frame.approval.id); proposals.delete(frame.target.operationId) } }
    return fail('UNAVAILABLE_IN_WEB', `the command ${frame.command} is unavailable in Web HTML`)
  }
  const unsubscribe = options.client.onFrame((frame) => {
    if (frame.type !== 'editor:request') return
    if (frame.command !== 'propose_ops') { const raw = storage?.getItem(key(frame.target.operationId)); if (raw) try { const remembered = JSON.parse(raw) as JournalRecord; if (remembered.fingerprint === fingerprint(frame)) { send(frame, remembered.result); return } send(frame, fail('OPERATION_ID_COLLISION', 'operation id is bound to different editor arguments')); return } catch { storage?.removeItem(key(frame.target.operationId)) } }
    void execute(frame).then((result) => { if (frame.command !== 'propose_ops') storage?.setItem(key(frame.target.operationId), JSON.stringify({ fingerprint: fingerprint(frame), result } satisfies JournalRecord)); send(frame, result) }, (error: unknown) => send(frame, fail('EDITOR_REQUEST_FAILED', error instanceof Error ? error.message : String(error))))
  })
  return { agentApi: createAgentApi(options.client), attachEditor(next) { adapter = next; return () => { if (adapter === next) adapter = undefined } }, client: () => ({ clientId: options.client.clientId, attached: options.client.state === 'ready' }), consumeApproval(id, hash) { if (approvals.get(id) !== hash) return false; approvals.delete(id); return true }, updateRevision(revision) { registration.updateRevision(revision) }, dispose() { approvals.clear(); consumedSaveApprovals.clear(); proposals.clear(); adapter = undefined; unsubscribe(); registration.dispose() } }
}
