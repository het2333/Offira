import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { parseAgentToolResult, type AgentApprovalProposal, type AgentToolResult, type JsonValue } from '@nexusdesk/protocol'

export interface HtmlToolBridge {
  request(command: string, arguments_: Record<string, JsonValue>, execution: ToolRunContext, authorization?: { approvalId: string; planHash: string; operationId?: string }): Promise<AgentToolResult>
  approve(toolName: string, proposal: AgentApprovalProposal, execution: ToolRunContext): Promise<{ approved: boolean; approvalId?: string }>
}
const output = { schema: { type: 'json' } as const, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const HTML_DSL_GUIDE = [
  'HTML DSL (stable sid targets from read_html):',
  'str_replace {old, new, sid?, replace_all?}',
  'replace_element {sid, html}',
  'set_inner_html {sid, html}',
  'set_text {sid, text}',
  'insert_html {sid, position: "before"|"after"|"prepend"|"append", html}',
  'remove {sid}',
  'move {sid, position: "before"|"after", ref_sid}',
  'set_attr {sid, name, value: string|null}',
  'set_style {sid, styles: {property: string|null}}',
  'set_tag {sid, tag}',
  'set_text_node {sid, index, text}',
  'wrap_text {sid, start, end, tag, attrs?}',
  'unwrap {sid}',
].join('\n')
function bounded(value: AgentToolResult): AgentToolResult { return parseAgentToolResult({ ok: value.ok, summary: value.summary, warnings: value.warnings, ...(value.changes ? { changes: value.changes } : {}), ...(value.verification ? { verification: value.verification } : {}), ...(value.transactionId ? { transactionId: value.transactionId } : {}), ...(value.data ? { data: value.data } : {}) }) }
function approvalDenied(action: string): AgentToolResult { return bounded({ ok: false, summary: `${action} was not approved.`, warnings: [{ code: 'APPROVAL_DENIED', message: `${action} was not approved.` }] }) }
function proposal(result: AgentToolResult): { operationId: string; proposal: AgentApprovalProposal } {
  const data = (result.data ?? {}) as Record<string, JsonValue>
  if (typeof data.operationId !== 'string' || typeof data.planHash !== 'string') throw new Error('HTML editor returned an invalid edit proposal')
  return { operationId: data.operationId, proposal: { operationId: data.operationId, planHash: data.planHash, summary: typeof data.summary === 'string' ? data.summary : result.summary, targets: Array.isArray(data.targets) ? data.targets.filter((v): v is string => typeof v === 'string') : [], warnings: result.warnings } }
}
/** Native Harness surface over existing GenOffice HTML apply_ops. */
export function createHtmlTools(bridge: HtmlToolBridge): ToolDefinition[] {
  const read = defineTool({ name: 'read_html', description: 'Read a bounded structural view of the current HTML document.', parameters: {}, output, isConcurrencySafe: () => true, async execute(_args, execution) { return bounded(await bridge.request('read_html', {}, execution)) as unknown as JsonValue } })
  const apply = defineTool({ name: 'apply_html_operations', description: 'Apply one ordered batch of existing GenOffice HTML apply_ops operations after exact user approval.', parameters: { operations: { type: 'array', required: true, items: { type: 'json' }, description: `Use only the curated GenOffice operations below. Stable sid values come from read_html.\n${HTML_DSL_GUIDE}` } }, output, async execute(args, execution) { const proposed = bounded(await bridge.request('propose_ops', { ops: args.operations }, execution)); if (!proposed.ok) return proposed as unknown as JsonValue; const value = proposal(proposed); const approval = await bridge.approve('apply_html_operations', value.proposal, execution); if (!approval.approved || approval.approvalId === undefined) return approvalDenied('HTML mutation') as unknown as JsonValue; return bounded(await bridge.request('apply_ops', { ops: args.operations }, execution, { approvalId: approval.approvalId, planHash: value.proposal.planHash, operationId: value.operationId })) as unknown as JsonValue } })
  const save = defineTool({ name: 'save_html', description: 'Save the current HTML document in place. The model cannot choose the path.', parameters: {}, output, async execute(_args, execution) { const approved = await bridge.approve('save_html', { planHash: 'save-current-html-in-place', summary: 'Save the current HTML document in place.', targets: ['current document'], warnings: [] }, execution); if (!approved.approved || approved.approvalId === undefined) return approvalDenied('HTML save') as unknown as JsonValue; return bounded(await bridge.request('save_html', { inPlace: true }, execution, { approvalId: approved.approvalId, planHash: 'save-current-html-in-place' })) as unknown as JsonValue } })
  return [read, apply, save]
}
