export const OFFICE_TOOL_NAMES = ['read_sheet', 'apply_sheet_operations', 'save_sheet'] as const

interface ToolScope {
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
  guard(callback: (execution: { name: string }) => string | undefined): () => void
  schemas(): Array<{ name: string }>
}

/** Apply and validate the non-bypassable capability boundary for one Agent. */
export function configureOfficeToolScope(agentContext: { tools: ToolScope }): void {
  const allowed = new Set<string>(OFFICE_TOOL_NAMES)
  agentContext.tools.restrict({ allow: OFFICE_TOOL_NAMES })
  agentContext.tools.guard((execution) =>
    allowed.has(execution.name)
      ? undefined
      : `NexusDesk Agents may execute only official Office tools; ${execution.name} is denied.`,
  )

  const effective = agentContext.tools
    .schemas()
    .map(({ name }) => name)
    .sort()
  const expected = [...OFFICE_TOOL_NAMES].sort()
  if (
    effective.length !== expected.length ||
    effective.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`unsafe Agent tool catalog: ${effective.join(', ')}`)
  }
}
