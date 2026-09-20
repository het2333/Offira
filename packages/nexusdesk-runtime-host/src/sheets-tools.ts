import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AgentApprovalProposal, AgentToolResult, JsonValue } from '@nexusdesk/protocol'
import { parseAgentToolResult } from '@nexusdesk/protocol'

export interface SheetsToolBridge {
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

export function createSheetsTools(bridge: SheetsToolBridge): ToolDefinition[] {
  const read = defineTool({
    name: 'read_sheet',
    description:
      'Read a scoped set of spreadsheet cells or, when addresses are omitted, a bounded workbook summary.',
    parameters: {
      sheet: {
        type: 'string',
        description: 'Worksheet name. Prefer this stable identifier when known.',
      },
      sheetId: { type: 'string', description: 'Current worksheet id returned by a prior read.' },
      addresses: {
        type: 'array',
        items: { type: 'string' },
        description: 'A bounded list of A1 cell or range addresses.',
      },
    },
    output: agentOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await bridge.request(
        'read_sheet',
        {
          ...(args.sheet === undefined ? {} : { sheet: args.sheet }),
          ...(args.sheetId === undefined ? {} : { sheetId: args.sheetId }),
          ...(args.addresses === undefined ? {} : { addresses: args.addresses }),
        },
        exec,
      )
      return result as unknown as JsonValue
    },
  })

  const apply = defineTool({
    name: 'apply_sheet_operations',
    description:
      'Apply one ordered, atomic batch of semantic spreadsheet operations after explicit user approval.',
    parameters: {
      operations: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description:
          'Ordered GenOffice spreadsheet DSL operations. Use worksheet names from read_sheet.',
      },
    },
    output: agentOutput,
    async execute(args, exec) {
      const proposalResult = await bridge.request('propose_ops', { ops: args.operations }, exec)
      if (!proposalResult.ok) return proposalResult as unknown as JsonValue
      const proposalData = (proposalResult.data ?? {}) as Record<string, JsonValue>
      const planHash = proposalData.planHash
      const operationId = proposalData.operationId
      if (typeof planHash !== 'string' || typeof operationId !== 'string') {
        throw new Error('spreadsheet editor returned an invalid edit proposal')
      }
      const proposal: AgentApprovalProposal = {
        operationId,
        planHash,
        summary:
          typeof proposalData.summary === 'string' ? proposalData.summary : proposalResult.summary,
        targets: Array.isArray(proposalData.targets)
          ? proposalData.targets.filter((value): value is string => typeof value === 'string')
          : [],
        warnings: proposalResult.warnings,
      }
      const approval = await bridge.approve('apply_sheet_operations', proposal, exec)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('spreadsheet mutation was not approved')
      }
      const result = await bridge.request('apply_ops', { ops: args.operations }, exec, {
        approvalId: approval.approvalId,
        planHash,
        operationId,
      })
      return result as unknown as JsonValue
    },
  })

  const save = defineTool({
    name: 'save_sheet',
    description: 'Save the proposed document snapshot in place after exact approval.',
    parameters: {},
    output: agentOutput,
    async execute(_args, execution) {
      const proposed = parseAgentToolResult(await bridge.request('propose_save', {}, execution))
      if (!proposed.ok) return proposed as unknown as JsonValue
      const data = (proposed.data ?? {}) as Record<string, JsonValue>
      if (
        typeof data.operationId !== 'string' ||
        typeof data.planHash !== 'string' ||
        typeof data.snapshotHash !== 'string' ||
        !data.snapshotHash
      ) {
        throw new Error('editor returned an invalid save proposal')
      }
      const proposal: AgentApprovalProposal = {
        operationId: data.operationId,
        planHash: data.planHash,
        summary: typeof data.summary === 'string' ? data.summary : proposed.summary,
        targets: Array.isArray(data.targets)
          ? data.targets.filter((value): value is string => typeof value === 'string')
          : [],
        warnings: proposed.warnings,
      }
      const approval = await bridge.approve('save_sheet', proposal, execution)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('document save was not approved')
      }
      return parseAgentToolResult(
        await bridge.request(
          'save_sheet',
          { inPlace: true, snapshotHash: data.snapshotHash },
          execution,
          {
            approvalId: approval.approvalId,
            planHash: data.planHash,
            operationId: data.operationId,
          },
        ),
      ) as unknown as JsonValue
    },
  })

  return [read, apply, save]
}
