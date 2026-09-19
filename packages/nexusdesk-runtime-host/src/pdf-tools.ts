import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  parseAgentToolResult,
  type AgentApprovalProposal,
  type AgentToolResult,
  type JsonValue,
} from '@nexusdesk/protocol'

export interface PdfToolBridge {
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

/** Do not let a renderer transport private objects into the Harness process. */
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
    throw new Error('PDF editor returned an invalid edit proposal')
  }
  return {
    operationId,
    proposal: {
      planHash,
      summary: typeof data.summary === 'string' ? data.summary : result.summary,
      targets: Array.isArray(data.targets)
        ? data.targets.filter((target): target is string => typeof target === 'string')
        : [],
      warnings: result.warnings,
    },
  }
}

export function createPdfTools(bridge: PdfToolBridge): ToolDefinition[] {
  const read = defineTool({
    name: 'read_pdf',
    description: 'Read a bounded page range from the open PDF, including extracted text.',
    parameters: {
      start: { type: 'integer', description: 'First page number (1-based).' },
      end: { type: 'integer', description: 'Last page number (inclusive); omit for one page.' },
    },
    output: agentOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return agentResult(
        await bridge.request(
          'read_pdf',
          {
            ...(args.start === undefined ? {} : { start: args.start }),
            ...(args.end === undefined ? {} : { end: args.end }),
          },
          exec,
        ),
      ) as unknown as JsonValue
    },
  })

  const apply = defineTool({
    name: 'apply_pdf_operations',
    description:
      'Apply one ordered batch of supported GenOffice PDF operations after exact user approval.',
    parameters: {
      operations: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description:
          'Ordered PDF apply_ops operations. Read the PDF first and use only operations it advertises.',
      },
    },
    output: agentOutput,
    async execute(args, exec) {
      const proposalResult = agentResult(
        await bridge.request('propose_ops', { ops: args.operations }, exec),
      )
      if (!proposalResult.ok) return proposalResult as unknown as JsonValue
      const { operationId, proposal } = proposalFrom(proposalResult)
      const approval = await bridge.approve('apply_pdf_operations', proposal, exec)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('PDF mutation was not approved')
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
    name: 'save_pdf',
    description: 'Save the open PDF in place. The model cannot choose or change the authorized path.',
    parameters: {},
    output: agentOutput,
    async execute(_args, exec) {
      const proposal: AgentApprovalProposal = {
        planHash: 'save-current-pdf-in-place',
        summary: 'Save the current PDF in place.',
        targets: ['current PDF'],
        warnings: [],
      }
      const approval = await bridge.approve('save_pdf', proposal, exec)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('PDF save was not approved')
      }
      return agentResult(
        await bridge.request('save_pdf', { inPlace: true }, exec, {
          approvalId: approval.approvalId,
          planHash: proposal.planHash,
        }),
      ) as unknown as JsonValue
    },
  })

  return [read, apply, save]
}
