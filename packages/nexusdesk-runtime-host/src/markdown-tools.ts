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
  render: (_args: unknown, value: JsonValue) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
}

const MARKDOWN_DSL_GUIDE = [
  'Markdown DSL (ordered and atomic):',
  'insertContent {after: number|"selection", markdown}',
  'replaceBlocks {target: "selection"|{start,end?}, markdown}',
  'deleteBlocks {target}',
  'replaceText {target, find, replace}',
  'setStyle {target, style: "bold"|"italic"|"strike"|"code", find?, mode?}',
  'setLink {target, href: string|null, find?}',
  'setBlockType {target, type: "paragraph"|"heading"|"blockquote"|"codeBlock", level?, language?}',
  'toggleList {target, list: "bullet"|"ordered"|"task"}',
  'moveBlocks {target, after}',
  'duplicateBlocks {target}',
  'insertTable {after, rows?, cols?, headerRow?}',
  'insertHorizontalRule {after}',
  'insertImage {after, src, alt?}',
  'editTable {target, action, row?, col?}',
  'setFrontmatter {yaml}',
].join('\n')

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

function approvalDenied(action: string): AgentToolResult {
  return agentResult({
    ok: false,
    summary: `${action} was not approved.`,
    warnings: [{ code: 'APPROVAL_DENIED', message: `${action} was not approved.` }],
  })
}

function proposalFrom(result: AgentToolResult): {
  operationId: string
  proposal: AgentApprovalProposal
} {
  const data = (result.data ?? {}) as Record<string, JsonValue>
  if (typeof data.planHash !== 'string' || typeof data.operationId !== 'string') {
    throw new Error('Markdown editor returned an invalid edit proposal')
  }
  return {
    operationId: data.operationId,
    proposal: {
      operationId: data.operationId,
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
      return agentResult(
        await bridge.request('read_markdown', {}, execution),
      ) as unknown as JsonValue
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
        description: `Use only the curated GenOffice operations below. Block indexes come from read_markdown.\n${MARKDOWN_DSL_GUIDE}`,
      },
    },
    output: agentOutput,
    async execute(args, execution) {
      const proposed = agentResult(
        await bridge.request('propose_ops', { ops: args.operations }, execution),
      )
      if (!proposed.ok) return proposed as unknown as JsonValue
      const { operationId, proposal } = proposalFrom(proposed)
      const approval = await bridge.approve('apply_markdown_operations', proposal, execution)
      if (!approval.approved || approval.approvalId === undefined) {
        return approvalDenied('Markdown mutation') as unknown as JsonValue
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
      const approval = await bridge.approve('save_markdown', proposal, execution)
      if (!approval.approved || approval.approvalId === undefined) {
        return approvalDenied('Markdown save') as unknown as JsonValue
      }
      return parseAgentToolResult(
        await bridge.request(
          'save_markdown',
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
