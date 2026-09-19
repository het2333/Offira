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
export const OFFICE_TOOL_NAMES = [
  ...SHEETS_TOOL_NAMES,
  ...DOCS_TOOL_NAMES,
  ...SLIDES_TOOL_NAMES,
  ...MARKDOWN_TOOL_NAMES,
  ...HTML_TOOL_NAMES,
] as const

export type OfficeEditorType = 'docs' | 'sheets' | 'slides' | 'markdown' | 'html'

interface ToolScope {
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
  guard(callback: (execution: { name: string }) => string | undefined): () => void
  schemas(): Array<{ name: string }>
}

/** Apply and validate the non-bypassable capability boundary for one Agent. */
export function officeToolNames(editorType: string): readonly string[] {
  if (editorType === 'docs') return DOCS_TOOL_NAMES
  if (editorType === 'sheets') return SHEETS_TOOL_NAMES
  if (editorType === 'slides') return SLIDES_TOOL_NAMES
  if (editorType === 'markdown') return MARKDOWN_TOOL_NAMES
  if (editorType === 'html') return HTML_TOOL_NAMES
  throw new Error(`unsupported Office editor: ${editorType}`)
}

/** Apply and validate the editor-specific, non-bypassable capability boundary. */
export function configureOfficeToolScope(
  agentContext: { tools: ToolScope },
  editorType: string,
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
    .schemas()
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
