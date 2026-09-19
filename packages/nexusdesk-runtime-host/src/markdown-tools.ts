import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  parseAgentToolResult,
  type AgentApprovalProposal,
  type AgentToolResult,
  type JsonValue,
} from '@nexusdesk/protocol'

export interface MarkdownToolBridge {
  request(
    command: string,
    arguments_: Record<string, JsonValue>,
    execution: ToolRunContext,
    authorization?: { approvalId: string; planHash: string; operationId?: string },
  ): Promise<AgentToolResult>
  approve(
    toolName: string,
    proposal: AgentApprovalProposal,
    execution: ToolRunContext,
  ): Promise<{ approved: boolean; approvalId?: string }>
}

const agentOutput = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

function agentResult(value: AgentToolResult): AgentToolResult {
  return parseAgentToolResult({
    ok: value.ok,
    summary: value.summary,
    warnings: value.warnings,
    ...(value.changes === undefined ? {} : { changes: value.changes }),
    ...(value.verification === undefined ? {} : { verification: value.verification }),
    ...(value.continuation === undefined ? {} : { continuation: value.continuation }),
    ...(value.transactionId === undefined ? {} : { transactionId: value.transactionId }),
    ...(value.data === undefined ? {} : { data: value.data }),
  })
}

function proposalFrom(result: AgentToolResult): { operationId: string; proposal: AgentApprovalProposal } {
  const data = (result.data ?? {}) as Record<string, JsonValue>
  if (typeof data.planHash !== 'string' || typeof data.operationId !== 'string') {
    throw new Error('Markdown editor returned an invalid edit proposal')
  }
  return {
    operationId: data.operationId,
    proposal: {
      planHash: data.planHash,
      summary: typeof data.summary === 'string' ? data.summary : result.summary,
      targets: Array.isArray(data.targets)
        ? data.targets.filter((target): target is string => typeof target === 'string')
        : [],
      warnings: result.warnings,
    },
  }
}

/** Curated, native Harness tools over the existing Markdown operation DSL. */
export function createMarkdownTools(bridge: MarkdownToolBridge): ToolDefinition[] {
  const read = defineTool({
    name: 'read_markdown',
    description: 'Read a bounded structural view of the current Markdown document.',
    parameters: {},
    output: agentOutput,
    isConcurrencySafe: () => true,
    async execute(_args, execution) {
      return agentResult(await bridge.request('read_markdown', {}, execution)) as unknown as JsonValue
    },
  })
  const apply = defineTool({
    name: 'apply_markdown_operations',
    description:
      'Apply one ordered batch of existing GenOffice Markdown apply_ops operations after exact user approval.',
    parameters: {
      operations: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description: 'Ordered existing Markdown apply_ops operations using fresh block indexes.',
      },
    },
    output: agentOutput,
    async execute(args, execution) {
      const proposed = agentResult(await bridge.request('propose_ops', { ops: args.operations }, execution))
      if (!proposed.ok) return proposed as unknown as JsonValue
      const { operationId, proposal } = proposalFrom(proposed)
      const approval = await bridge.approve('apply_markdown_operations', proposal, execution)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('Markdown mutation was not approved')
      }
      return agentResult(
        await bridge.request('apply_ops', { ops: args.operations }, execution, {
          approvalId: approval.approvalId,
          planHash: proposal.planHash,
          operationId,
        }),
      ) as unknown as JsonValue
    },
  })
  const save = defineTool({
    name: 'save_markdown',
    description: 'Save the current Markdown document in place. The model cannot choose the path.',
    parameters: {},
    output: agentOutput,
    async execute(_args, execution) {
      const proposal: AgentApprovalProposal = {
        planHash: 'save-current-markdown-in-place',
        summary: 'Save the current Markdown document in place.',
        targets: ['current document'],
        warnings: [],
      }
      const approval = await bridge.approve('save_markdown', proposal, execution)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('Markdown save was not approved')
      }
      return agentResult(
        await bridge.request('save_markdown', { inPlace: true }, execution, {
          approvalId: approval.approvalId,
          planHash: proposal.planHash,
        }),
      ) as unknown as JsonValue
    },
  })
  return [read, apply, save]
}
