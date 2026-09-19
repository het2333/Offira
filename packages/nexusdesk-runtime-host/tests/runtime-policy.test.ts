import { describe, expect, it } from 'vitest'

import { configureOfficeToolScope, OFFICE_TOOL_NAMES } from '../src/runtime-policy'

class EffectiveToolCatalog {
  private visible = new Set(['bash', 'read_file', 'web_fetch', ...OFFICE_TOOL_NAMES])
  guardCallback: ((execution: { name: string }) => string | undefined) | undefined

  restrict(filter: { allow?: readonly string[] }): () => void {
    this.visible = new Set(
      [...this.visible].filter((name) => filter.allow?.includes(name) === true),
    )
    return () => undefined
  }

  guard(callback: (execution: { name: string }) => string | undefined): () => void {
    this.guardCallback = callback
    return () => undefined
  }

  schemas(): Array<{ name: string }> {
    return [...this.visible].map((name) => ({ name }))
  }
}

describe('Office-only Agent capability policy', () => {
  it('removes inherited shell, filesystem, search, skill, and web tools from the effective catalog', () => {
    const tools = new EffectiveToolCatalog()

    configureOfficeToolScope({ tools })

    expect(
      tools
        .schemas()
        .map(({ name }) => name)
        .sort(),
    ).toEqual([...OFFICE_TOOL_NAMES].sort())
  })

  it('denies non-Office execution even if a later plugin exposes a tool', () => {
    const tools = new EffectiveToolCatalog()
    configureOfficeToolScope({ tools })

    expect(tools.guardCallback?.({ name: 'bash' })).toMatch(/Office tools/)
    expect(tools.guardCallback?.({ name: 'read_sheet' })).toBeUndefined()
  })
})
