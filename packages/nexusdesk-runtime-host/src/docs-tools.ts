import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  parseAgentToolResult,
  type AgentApprovalProposal,
  type AgentToolResult,
  type JsonValue,
} from '@nexusdesk/protocol'

export interface DocsToolBridge {
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
  render: (_args: unknown, value: JsonValue) => [
    {
      type: 'text' as const,
      text: JSON.stringify(value),
    },
  ],
}

/** Copy only the stable Agent envelope before any value reaches Harness. */
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

function proposalFrom(result: AgentToolResult): {
  operationId: string
  proposal: AgentApprovalProposal
} {
  const data = (result.data ?? {}) as Record<string, JsonValue>
  const planHash = data.planHash
  const operationId = data.operationId
  if (typeof planHash !== 'string' || typeof operationId !== 'string') {
    throw new Error('document editor returned an invalid edit proposal')
  }
  return {
    operationId,
    proposal: {
      operationId,
      planHash,
      summary: typeof data.summary === 'string' ? data.summary : result.summary,
      targets: Array.isArray(data.targets)
        ? data.targets.filter((target): target is string => typeof target === 'string')
        : [],
      warnings: result.warnings,
    },
  }
}

export function createDocsTools(bridge: DocsToolBridge): ToolDefinition[] {
  const read = defineTool({
    name: 'read_document',
    description:
      'Read a bounded structural view of the current document, including block indexes and text.',
    parameters: {
      scope: {
        type: 'string',
        description: 'Read scope. Use "document" unless a later read advertises another scope.',
      },
    },
    output: agentOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return agentResult(
        await bridge.request(
          'read_document',
          { ...(args.scope === undefined ? {} : { scope: args.scope }) },
          exec,
        ),
      ) as unknown as JsonValue
    },
  })

  const apply = defineTool({
    name: 'apply_document_operations',
    description:
      'Apply one ordered batch of GenOffice document DSL operations after exact user approval.',
    parameters: {
      operations: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description:
          'Ordered GenOffice Docs apply_ops operations using fresh block indexes from read_document.',
      },
    },
    output: agentOutput,
    async execute(args, exec) {
      const proposalResult = agentResult(
        await bridge.request('propose_ops', { ops: args.operations }, exec),
      )
      if (!proposalResult.ok) return proposalResult as unknown as JsonValue
      const { operationId, proposal } = proposalFrom(proposalResult)
      const approval = await bridge.approve('apply_document_operations', proposal, exec)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('document mutation was not approved')
      }
      return agentResult(
        await bridge.request('apply_ops', { ops: args.operations }, exec, {
          approvalId: approval.approvalId,
          planHash: proposal.planHash,
          operationId,
        }),
      ) as unknown as JsonValue
    },
  })

  const save = defineTool({
    name: 'save_document',
    description:
      'Save the open document in place. The model cannot choose or change the authorized path.',
    parameters: {},
    output: agentOutput,
    async execute(_args, exec) {
      const proposal: AgentApprovalProposal = {
        planHash: 'save-current-document-in-place',
        summary: 'Save the current document in place.',
        targets: ['current document'],
        warnings: [],
      }
      const approval = await bridge.approve('save_document', proposal, exec)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('document save was not approved')
      }
      return agentResult(
        await bridge.request('save_document', { inPlace: true }, exec, {
          approvalId: approval.approvalId,
          planHash: proposal.planHash,
        }),
      ) as unknown as JsonValue
    },
  })

  return [read, apply, save]
}
