import { describe, expect, it } from 'vitest'

import {
  configureOfficeToolScope,
  DOCS_TOOL_NAMES,
  HTML_TOOL_NAMES,
  MARKDOWN_TOOL_NAMES,
  OFFICE_TOOL_NAMES,
  PDF_TOOL_NAMES,
  SHEETS_TOOL_NAMES,
} from '../src/runtime-policy'

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

    configureOfficeToolScope({ tools }, 'sheets')

    expect(
      tools
        .schemas()
        .map(({ name }) => name)
        .sort(),
    ).toEqual([...SHEETS_TOOL_NAMES].sort())
  })

  it('denies non-Office execution even if a later plugin exposes a tool', () => {
    const tools = new EffectiveToolCatalog()
    configureOfficeToolScope({ tools }, 'sheets')

    expect(tools.guardCallback?.({ name: 'bash' })).toMatch(/Office tools/)
    expect(tools.guardCallback?.({ name: 'read_sheet' })).toBeUndefined()
  })

  it('exposes only Docs tools for a Docs session', () => {
    const tools = new EffectiveToolCatalog()

    configureOfficeToolScope({ tools }, 'docs')

    expect(
      tools
        .schemas()
        .map(({ name }) => name)
        .sort(),
    ).toEqual([...DOCS_TOOL_NAMES].sort())
    expect(tools.guardCallback?.({ name: 'read_document' })).toBeUndefined()
    expect(tools.guardCallback?.({ name: 'read_sheet' })).toMatch(/Office tools/)
  })

  it('exposes only Markdown tools for a Markdown session', () => {
    const tools = new EffectiveToolCatalog()

    configureOfficeToolScope({ tools }, 'markdown')

    expect(tools.schemas().map(({ name }) => name).sort()).toEqual([...MARKDOWN_TOOL_NAMES].sort())
    expect(tools.guardCallback?.({ name: 'read_markdown' })).toBeUndefined()
    expect(tools.guardCallback?.({ name: 'read_document' })).toMatch(/Office tools/)
  })

  it('exposes only HTML tools for an HTML session', () => {
    const tools = new EffectiveToolCatalog()
    configureOfficeToolScope({ tools }, 'html')
    expect(tools.schemas().map(({ name }) => name).sort()).toEqual([...HTML_TOOL_NAMES].sort())
    expect(tools.guardCallback?.({ name: 'read_html' })).toBeUndefined()
    expect(tools.guardCallback?.({ name: 'read_markdown' })).toMatch(/Office tools/)
  })

  it('exposes only PDF tools for a PDF session', () => {
    const tools = new EffectiveToolCatalog()
    configureOfficeToolScope({ tools }, 'pdf')
    expect(tools.schemas().map(({ name }) => name).sort()).toEqual([...PDF_TOOL_NAMES].sort())
    expect(tools.guardCallback?.({ name: 'read_pdf' })).toBeUndefined()
    expect(tools.guardCallback?.({ name: 'read_document' })).toMatch(/Office tools/)
  })

  it('rejects an unknown editor kind instead of widening the catalog', () => {
    const tools = new EffectiveToolCatalog()

    expect(() => configureOfficeToolScope({ tools }, 'unknown')).toThrow(/unsupported Office editor/i)
  })
})
