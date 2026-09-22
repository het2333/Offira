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
      operationSchema: { type: 'string', description: 'Read canonical DSL input fields for an operation (e.g. add_chart), or "*" to list all available operations. This returns guidance, not cell data.' },
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
          ...(args.operationSchema === undefined ? {} : { operationSchema: args.operationSchema }),
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
      'Apply one ordered, atomic batch of semantic spreadsheet operations after explicit user approval. Before calling, briefly explain the intended changes and affected range in the user\'s language. Read operation fields with read_sheet(operationSchema) instead of guessing. Do not repeat a mutation whose outcome is unknown; read its state first.',
    parameters: {
      operations: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description:
          'Ordered GenOffice DSL operations. Basic shapes: {op:"set_cell",sheetId,address,value}, {op:"set_formula",sheetId,address,formula}, {op:"clear_cell",sheetId,address}. Use actual sheetId from read_sheet. For other operations call read_sheet with operationSchema; "*" lists capabilities. Do not invent API fields.',
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
        return {
          ok: false,
          summary: 'The operation was not approved.',
          warnings: [{ code: 'APPROVAL_DENIED', message: 'The operation was not approved.' }],
        } as unknown as JsonValue
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
        return {
          ok: false,
          summary: 'The operation was not approved.',
          warnings: [{ code: 'APPROVAL_DENIED', message: 'The operation was not approved.' }],
        } as unknown as JsonValue
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
