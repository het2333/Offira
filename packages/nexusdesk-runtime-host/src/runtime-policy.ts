export const SHEETS_TOOL_NAMES = ['read_sheet', 'apply_sheet_operations', 'save_sheet'] as const
export const DOCS_TOOL_NAMES = [
  'read_document',
  'apply_document_operations',
  'save_document',
] as const
export const MARKDOWN_TOOL_NAMES = [
  'read_markdown',
  'apply_markdown_operations',
  'save_markdown',
] as const
export const HTML_TOOL_NAMES = ['read_html', 'apply_html_operations', 'save_html'] as const
export const SLIDES_TOOL_NAMES = [
  'read_presentation',
  'apply_presentation_operations',
  'save_presentation',
  'undo_presentation',
  'redo_presentation',
] as const
/** Curated, semantic-only PDF capabilities registered by createPdfTools(). */
export const PDF_TOOL_NAMES = [
  'read_pdf',
  'markup_pdf_text',
  'read_pdf_annotations',
  'edit_pdf_text',
  'insert_pdf_text',
  'add_pdf_note',
  'list_pdf_page_images',
  'list_pdf_form_fields',
  'insert_pdf_image',
  'transform_pdf_image',
  'fill_pdf_form',
  'rotate_pdf_pages',
  'delete_pdf_page',
  'reorder_pdf_pages',
  'set_pdf_metadata',
  'update_pdf_annotation',
  'modify_pdf_pages',
  'redact_pdf',
  'save_pdf',
] as const
export const OFFICE_TOOL_NAMES = [
  ...SHEETS_TOOL_NAMES,
  ...DOCS_TOOL_NAMES,
  ...SLIDES_TOOL_NAMES,
  ...PDF_TOOL_NAMES,
  ...MARKDOWN_TOOL_NAMES,
  ...HTML_TOOL_NAMES,
] as const

export type OfficeEditorType = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'

interface ToolScope {
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
  guard(callback: (execution: { name: string }) => string | undefined): () => void
  schemas(scope: object): Array<{ name: string }>
}

/** Apply and validate the non-bypassable capability boundary for one Agent. */
export function officeToolNames(editorType: string): readonly string[] {
  if (editorType === 'docs') return DOCS_TOOL_NAMES
  if (editorType === 'sheets') return SHEETS_TOOL_NAMES
  if (editorType === 'slides') return SLIDES_TOOL_NAMES
  if (editorType === 'pdf') return PDF_TOOL_NAMES
  if (editorType === 'markdown') return MARKDOWN_TOOL_NAMES
  if (editorType === 'html') return HTML_TOOL_NAMES
  throw new Error(`unsupported Office editor: ${editorType}`)
}

/** Apply and validate the editor-specific, non-bypassable capability boundary. */
export function configureOfficeToolScope(
  agentContext: { tools: ToolScope },
  editorType: string,
  agentScope: object,
): void {
  const toolNames = officeToolNames(editorType)
  const allowed = new Set<string>(toolNames)
  agentContext.tools.restrict({ allow: toolNames })
  agentContext.tools.guard((execution) =>
    allowed.has(execution.name)
      ? undefined
      : `NexusDesk Agents may execute only official Office tools; ${execution.name} is denied.`,
  )

  const effective = agentContext.tools
    // Harness reads are explicitly scope-keyed even on agent.ctx.tools.
    // Omitting the Agent returns the unrestricted global registry.
    .schemas(agentScope)
    .map(({ name }) => name)
    .sort()
  const expected = [...toolNames].sort()
  if (
    effective.length !== expected.length ||
    effective.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`unsafe Agent tool catalog: ${effective.join(', ')}`)
  }
}
