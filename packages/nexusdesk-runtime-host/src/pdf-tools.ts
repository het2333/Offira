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
  render: (_args: unknown, value: JsonValue) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
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
  const snapshotHash = data.snapshotHash
  if (
    typeof planHash !== 'string' ||
    typeof operationId !== 'string' ||
    typeof snapshotHash !== 'string'
  ) {
    throw new Error('PDF editor returned an invalid edit proposal')
  }
  return {
    operationId,
    proposal: {
      planHash,
      operationId,
      snapshotHash,
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

  const markup = defineTool({
    name: 'markup_pdf_text',
    description:
      'Highlight, underline, or strike out verified text on one PDF page after exact user approval. Read the page first and pass text exactly as it appears.',
    parameters: {
      page: { type: 'integer', required: true, description: 'Page number (1-based).' },
      text: { type: 'string', required: true, description: 'Exact text to mark on that page.' },
      type: {
        type: 'string',
        required: true,
        enum: ['highlight', 'underline', 'strikeout'],
        description: 'Markup type.',
      },
      color: { type: 'string', description: 'Optional #RRGGBB color.' },
      all: { type: 'boolean', description: 'Mark every occurrence on the page.' },
    },
    output: agentOutput,
    async execute(args, exec) {
      const semantic = {
        op: 'markup_pdf_text',
        page: args.page,
        text: args.text,
        type: args.type,
        ...(args.color === undefined ? {} : { color: args.color }),
        ...(args.all === undefined ? {} : { all: args.all }),
      }
      const proposalResult = agentResult(
        await bridge.request('propose_ops', { ops: [semantic] }, exec),
      )
      if (!proposalResult.ok) return proposalResult as unknown as JsonValue
      const { operationId, proposal } = proposalFrom(proposalResult)
      const approval = await bridge.approve('markup_pdf_text', proposal, exec)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('PDF markup was not approved')
      }
      return agentResult(
        await bridge.request('apply_ops', {}, exec, {
          approvalId: approval.approvalId,
          planHash: proposal.planHash,
          operationId,
        }),
      ) as unknown as JsonValue
    },
  })

  const annotations = defineTool({
    name: 'read_pdf_annotations',
    description: 'Read sticky notes and text markups on a bounded PDF page range.',
    parameters: {
      start: { type: 'integer', description: 'First page number (1-based).' },
      end: { type: 'integer', description: 'Last page number (inclusive).' },
    },
    output: agentOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return agentResult(
        await bridge.request(
          'read_pdf',
          {
            include: 'annotations',
            ...(args.start === undefined ? {} : { start: args.start }),
            ...(args.end === undefined ? {} : { end: args.end }),
          },
          exec,
        ),
      ) as unknown as JsonValue
    },
  })

  const mutate = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    semantic: (args: Record<string, unknown>) => Record<string, JsonValue>,
  ): ToolDefinition =>
    defineTool({
      name,
      description,
      parameters: parameters as never,
      output: agentOutput,
      async execute(args, exec) {
        const proposalResult = agentResult(
          await bridge.request(
            'propose_ops',
            {
              ops: [semantic(args as Record<string, unknown>)],
            },
            exec,
          ),
        )
        if (!proposalResult.ok) return proposalResult as unknown as JsonValue
        const { operationId, proposal } = proposalFrom(proposalResult)
        const approval = await bridge.approve(name, proposal, exec)
        if (!approval.approved || approval.approvalId === undefined)
          throw new Error(`${name} was not approved`)
        return agentResult(
          await bridge.request('apply_ops', {}, exec, {
            approvalId: approval.approvalId,
            planHash: proposal.planHash,
            operationId,
          }),
        ) as unknown as JsonValue
      },
    })

  const editText = mutate(
    'edit_pdf_text',
    'Replace one exact text run on a page after approval.',
    {
      page: { type: 'integer', required: true, description: 'Page number (1-based).' },
      oldText: { type: 'string', required: true, description: 'Exact existing text to replace.' },
      newText: {
        type: 'string',
        required: true,
        description: 'Replacement text; empty removes the run.',
      },
    },
    (args) => ({
      op: 'edit_pdf_text',
      page: args.page as number,
      oldText: args.oldText as string,
      newText: args.newText as string,
    }),
  )
  const insertText = mutate(
    'insert_pdf_text',
    'Insert new text at a PDF-space baseline after approval.',
    {
      page: { type: 'integer', required: true, description: 'Page number (1-based).' },
      text: { type: 'string', required: true, description: 'Text to insert.' },
      x: { type: 'number', required: true, description: 'Baseline x in PDF points.' },
      y: { type: 'number', required: true, description: 'Baseline y in PDF points.' },
      fontSize: { type: 'number', description: 'Font size in points; defaults to 14.' },
      color: { type: 'string', description: 'Optional #RRGGBB color.' },
    },
    (args) => ({
      op: 'insert_pdf_text',
      page: args.page as number,
      text: args.text as string,
      x: args.x as number,
      y: args.y as number,
      ...(args.fontSize === undefined ? {} : { fontSize: args.fontSize as number }),
      ...(args.color === undefined ? {} : { color: args.color as string }),
    }),
  )
  const addNote = mutate(
    'add_pdf_note',
    'Add a sticky note at a PDF-space point after approval.',
    {
      page: { type: 'integer', required: true, description: 'Page number (1-based).' },
      text: { type: 'string', required: true, description: 'Note contents.' },
      x: { type: 'number', required: true, description: 'Pin x in PDF points.' },
      y: { type: 'number', required: true, description: 'Pin y in PDF points.' },
      color: { type: 'string', description: 'Optional #RRGGBB color.' },
    },
    (args) => ({
      op: 'add_pdf_note',
      page: args.page as number,
      text: args.text as string,
      x: args.x as number,
      y: args.y as number,
      ...(args.color === undefined ? {} : { color: args.color as string }),
    }),
  )
  const images = defineTool({
    name: 'list_pdf_page_images',
    description: 'List content-stream images embedded in the current PDF.',
    parameters: {},
    output: agentOutput,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return agentResult(
        await bridge.request('read_pdf', { include: 'images' }, exec),
      ) as unknown as JsonValue
    },
  })
  const forms = defineTool({
    name: 'list_pdf_form_fields',
    description: 'List interactive PDF form fields and their current values.',
    parameters: {},
    output: agentOutput,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return agentResult(
        await bridge.request('read_pdf', { include: 'forms' }, exec),
      ) as unknown as JsonValue
    },
  })
  const insertImage = mutate(
    'insert_pdf_image',
    'Insert base64-encoded PNG content into a PDF rectangle after approval.',
    {
      page: { type: 'integer', required: true, description: 'Page number (1-based).' },
      image: {
        type: 'string',
        required: true,
        description: 'PNG base64 without a data URL prefix.',
      },
      rect: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x1,y1,x2,y2] in PDF points.',
      },
      layer: {
        type: 'string',
        enum: ['aboveText', 'belowText'],
        description: 'Content layer; defaults to aboveText.',
      },
    },
    (args) => ({
      op: 'insert_pdf_image',
      page: args.page as number,
      image: args.image as string,
      rect: args.rect as JsonValue,
      ...(args.layer === undefined ? {} : { layer: args.layer as string }),
    }),
  )
  const transformImage = mutate(
    'transform_pdf_image',
    'Move, resize, replace, delete, rotate, or bake one discovered PDF image after approval. Bakes support flip, opacity, crop, and background removal.',
    {
      action: {
        type: 'string',
        enum: ['transform', 'replace', 'delete', 'rotate', 'bake'],
        description: 'Image operation; defaults to transform.',
      },
      page: { type: 'integer', required: true, description: 'Page number (1-based).' },
      oldRect: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: 'Current [x1,y1,x2,y2] from list_pdf_page_images.',
      },
      rect: {
        type: 'array',
        items: { type: 'number' },
        description: 'New [x1,y1,x2,y2] in PDF points.',
      },
      image: { type: 'string', description: 'Replacement PNG base64, without a data URL prefix.' },
      quarterTurns: {
        type: 'integer',
        enum: [0, 1, 2, 3],
        description:
          'Clockwise quarter turns. Rotating without rect swaps width/height around center.',
      },
      bake: {
        type: 'string',
        enum: ['flip', 'opacity', 'crop', 'cutout'],
        description: 'Pixel operation for action=bake.',
      },
      axis: { type: 'string', enum: ['h', 'v'], description: 'Flip axis.' },
      alpha: { type: 'number', description: 'Opacity from 0 to 1.' },
      tolerance: { type: 'number', description: 'Background removal tolerance from 0 to 100.' },
      crop: {
        type: 'array',
        items: { type: 'number' },
        description: 'Kept [left,top,right,bottom] fractions from 0 to 1.',
      },
      layer: { type: 'string', enum: ['aboveText', 'belowText'], description: 'Content layer.' },
    },
    (args) => ({
      op: 'transform_pdf_image',
      page: args.page as number,
      oldRect: args.oldRect as JsonValue,
      ...Object.fromEntries(
        ['action', 'rect', 'image', 'quarterTurns', 'bake', 'axis', 'alpha', 'tolerance', 'crop']
          .filter((key) => args[key] !== undefined)
          .map((key) => [key, args[key] as JsonValue]),
      ),
      ...(args.layer === undefined ? {} : { layer: args.layer as string }),
    }),
  )
  const updateAnnotation = mutate(
    'update_pdf_annotation',
    'Reply to or edit a note, or delete an annotation and its replies, after approval. Read annotations first for the exact saved/pending key.',
    {
      action: {
        type: 'string',
        required: true,
        enum: ['reply', 'edit', 'delete'],
        description: 'Annotation operation.',
      },
      page: { type: 'integer', required: true, description: 'Original page number (1-based).' },
      key: {
        type: 'string',
        required: true,
        description: 'Exact S<object> or P<id> key from read_pdf_annotations.',
      },
      text: { type: 'string', description: 'Contents for reply or edit.' },
    },
    (args) => ({
      op: 'update_pdf_annotation',
      action: args.action as string,
      page: args.page as number,
      key: args.key as string,
      ...(args.text === undefined ? {} : { text: args.text as string }),
    }),
  )
  const modifyPages = mutate(
    'modify_pdf_pages',
    'Save pending edits and rewrite the authorized PDF in place after approval: insert a blank page, resize all pages, or crop pages. Page numbers are visible positions after pending order/deletions are saved.',
    {
      action: {
        type: 'string',
        required: true,
        enum: ['insertBlankPage', 'setPageSize', 'cropPages'],
        description: 'Page rewrite operation.',
      },
      afterPage: {
        type: 'integer',
        description: 'Insert after this visible page (0 inserts at front).',
      },
      width: {
        type: 'number',
        description: 'Target width in points, greater than 0 and at most 14400.',
      },
      height: {
        type: 'number',
        description: 'Target height in points, greater than 0 and at most 14400.',
      },
      pages: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Visible page numbers (1-based) to crop.',
      },
      crop: {
        type: 'array',
        items: { type: 'number' },
        description: 'Kept [left,top,right,bottom] displayed-page fractions, 0 to 1.',
      },
    },
    (args) => ({
      op: 'modify_pdf_pages',
      ...Object.fromEntries(
        ['action', 'afterPage', 'width', 'height', 'pages', 'crop']
          .filter((key) => args[key] !== undefined)
          .map((key) => [key, args[key] as JsonValue]),
      ),
    }),
  )
  const form = mutate(
    'fill_pdf_form',
    'Set one interactive PDF form field after approval.',
    {
      name: { type: 'string', required: true, description: 'AcroForm field name.' },
      kind: {
        type: 'string',
        required: true,
        enum: ['text', 'checkbox', 'radio', 'choice'],
        description: 'Field kind.',
      },
      value: {
        type: 'json',
        required: true,
        description: 'Value appropriate for the selected field kind.',
      },
    },
    (args) => ({
      op: 'fill_pdf_form',
      name: args.name as string,
      kind: args.kind as string,
      value: args.value as JsonValue,
    }),
  )
  const rotatePages = mutate(
    'rotate_pdf_pages',
    'Rotate selected pages after approval.',
    {
      pages: {
        type: 'array',
        required: true,
        items: { type: 'integer' },
        description: '1-based pages to rotate.',
      },
      dir: {
        type: 'integer',
        required: true,
        enum: [-90, 90, 180],
        description: 'Rotation in degrees.',
      },
    },
    (args) => ({ op: 'rotate_pdf_pages', pages: args.pages as JsonValue, dir: args.dir as number }),
  )
  const deletePage = mutate(
    'delete_pdf_page',
    'Delete one page after approval; at least one page must remain.',
    {
      page: { type: 'integer', required: true, description: 'Page number (1-based).' },
    },
    (args) => ({ op: 'delete_pdf_page', page: args.page as number }),
  )
  const reorderPages = mutate(
    'reorder_pdf_pages',
    'Reorder every page after approval.',
    {
      pages: {
        type: 'array',
        required: true,
        items: { type: 'integer' },
        description: 'Complete 1-based page order.',
      },
    },
    (args) => ({ op: 'reorder_pdf_pages', pages: args.pages as JsonValue }),
  )
  const metadata = mutate(
    'set_pdf_metadata',
    'Update document metadata after approval.',
    {
      title: { type: 'string', description: 'Document title.' },
      author: { type: 'string', description: 'Document author.' },
      subject: { type: 'string', description: 'Document subject.' },
      keywords: { type: 'string', description: 'Document keywords.' },
    },
    (args) => ({
      op: 'set_pdf_metadata',
      ...Object.fromEntries(
        ['title', 'author', 'subject', 'keywords']
          .filter((key) => typeof args[key] === 'string')
          .map((key) => [key, args[key] as string]),
      ),
    }),
  )
  const redactionUnavailable = defineTool({
    name: 'redact_pdf',
    description: 'Permanently redact PDF content.',
    parameters: {},
    output: agentOutput,
    isConcurrencySafe: () => true,
    async execute() {
      return agentResult({
        ok: false,
        summary:
          'Permanent redaction is unavailable in Local Web because it requires a separate Save As destination.',
        warnings: [
          {
            code: 'UNAVAILABLE_IN_WEB',
            message:
              'The Local Web driver permits only the authorized in-place file and rejects permanent redaction.',
          },
        ],
      }) as unknown as JsonValue
    },
  })

  const save = defineTool({
    name: 'save_pdf',
    description:
      'Save the open PDF in place after exact user approval. The model cannot choose or change the authorized path.',
    parameters: {},
    output: agentOutput,
    async execute(_args, exec) {
      const proposalResult = agentResult(await bridge.request('propose_save', {}, exec))
      if (!proposalResult.ok) return proposalResult as unknown as JsonValue
      const { operationId, proposal } = proposalFrom(proposalResult)
      const approval = await bridge.approve('save_pdf', proposal, exec)
      if (!approval.approved || approval.approvalId === undefined) {
        throw new Error('PDF save was not approved')
      }
      return agentResult(
        await bridge.request('save_pdf', { inPlace: true }, exec, {
          approvalId: approval.approvalId,
          planHash: proposal.planHash,
          operationId,
        }),
      ) as unknown as JsonValue
    },
  })

  /*
   * Deliberately do not expose a raw `operations: json[]` escape hatch here. The
   * renderer owns page geometry and canonical pending edits; callers get semantic
   * tools or a bounded typed unavailable result.
   */
  return [
    read,
    markup,
    annotations,
    editText,
    insertText,
    addNote,
    images,
    forms,
    insertImage,
    transformImage,
    form,
    rotatePages,
    deletePage,
    reorderPages,
    metadata,
    updateAnnotation,
    modifyPages,
    redactionUnavailable,
    save,
  ]
}
