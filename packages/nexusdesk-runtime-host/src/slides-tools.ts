import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  parseAgentToolResult,
  type AgentApprovalProposal,
  type AgentToolResult,
  type JsonValue,
} from '@nexusdesk/protocol'

export interface SlidesToolBridge {
  request(command: string, arguments_: Record<string, JsonValue>, execution: ToolRunContext, authorization?: { approvalId: string; planHash: string; operationId?: string }): Promise<AgentToolResult>
  approve(toolName: string, proposal: AgentApprovalProposal, execution: ToolRunContext): Promise<{ approved: boolean; approvalId?: string }>
}

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

function result(value: AgentToolResult): AgentToolResult {
  return parseAgentToolResult({
    ok: value.ok, summary: value.summary, warnings: value.warnings,
    ...(value.changes === undefined ? {} : { changes: value.changes }),
    ...(value.verification === undefined ? {} : { verification: value.verification }),
    ...(value.continuation === undefined ? {} : { continuation: value.continuation }),
    ...(value.transactionId === undefined ? {} : { transactionId: value.transactionId }),
    ...(value.data === undefined ? {} : { data: value.data }),
  })
}

function proposal(value: AgentToolResult): { operationId: string; proposal: AgentApprovalProposal } {
  const data = (value.data ?? {}) as Record<string, JsonValue>
  if (typeof data.planHash !== 'string' || typeof data.operationId !== 'string') {
    throw new Error('presentation editor returned an invalid edit proposal')
  }
  return {
    operationId: data.operationId,
    proposal: {
      planHash: data.planHash,
      summary: typeof data.summary === 'string' ? data.summary : value.summary,
      targets: Array.isArray(data.targets) ? data.targets.filter((item): item is string => typeof item === 'string') : [],
      warnings: value.warnings,
    },
  }
}

export function createSlidesTools(bridge: SlidesToolBridge): ToolDefinition[] {
  return [
    defineTool({
      name: 'read_presentation',
      description: 'Read a bounded structural view of the current presentation, including slide and element identities.',
      parameters: {}, output, isConcurrencySafe: () => true,
      async execute(_args, execution) { return result(await bridge.request('read_presentation', {}, execution)) as unknown as JsonValue },
    }),
    defineTool({
      name: 'apply_presentation_operations',
      description: 'Apply one ordered GenOffice presentation transaction after exact user approval.',
      parameters: { operations: { type: 'array', required: true, items: { type: 'json' }, description: 'Ordered GenOffice PPTX transaction operations using identities from read_presentation.' } },
      output,
      async execute(args, execution) {
        const proposed = result(await bridge.request('propose_ops', { ops: args.operations }, execution))
        if (!proposed.ok) return proposed as unknown as JsonValue
        const pending = proposal(proposed)
        const approval = await bridge.approve('apply_presentation_operations', pending.proposal, execution)
        if (!approval.approved || approval.approvalId === undefined) throw new Error('presentation mutation was not approved')
        return result(await bridge.request('apply_ops', { ops: args.operations }, execution, { approvalId: approval.approvalId, planHash: pending.proposal.planHash, operationId: pending.operationId })) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'save_presentation',
      description: 'Save the open presentation in place. The model cannot choose or change the authorized path.',
      parameters: {}, output,
      async execute(_args, execution) {
        const pending: AgentApprovalProposal = { planHash: 'save-current-presentation-in-place', summary: 'Save the current presentation in place.', targets: ['current presentation'], warnings: [] }
        const approval = await bridge.approve('save_presentation', pending, execution)
        if (!approval.approved || approval.approvalId === undefined) throw new Error('presentation save was not approved')
        return result(await bridge.request('save_presentation', { inPlace: true }, execution, { approvalId: approval.approvalId, planHash: pending.planHash })) as unknown as JsonValue
      },
    }),
  ]
}
