import { describe, expect, it, vi } from 'vitest'

import type { AgentToolResult } from '@nexusdesk/protocol'
import { createSheetsTools } from '../src/sheets-tools'

const success: AgentToolResult = {
  ok: true,
  summary: 'Applied one spreadsheet operation.',
  changes: { targets: ['Summary!B2'], count: 1 },
  warnings: [],
  verification: { passed: true, issues: [] },
}

describe('official Harness Sheets tools', () => {
  it('registers curated semantic tool names rather than engine methods', () => {
    const tools = createSheetsTools({
      request: vi.fn().mockResolvedValue(success),
      approve: vi.fn().mockResolvedValue(true),
    })

    expect(tools.map((tool) => tool.name)).toEqual([
      'read_sheet',
      'apply_sheet_operations',
      'save_sheet',
    ])
    expect(tools.some((tool) => tool.name.toLowerCase().includes('univer'))).toBe(false)
  })

  it('binds mutation approval to the exact semantic operation batch', async () => {
    const request = vi.fn().mockResolvedValue(success)
    const approve = vi.fn().mockResolvedValue(true)
    const apply = createSheetsTools({ request, approve })[1]!
    const operations = [{ op: 'set_cell', sheet: 'Summary', address: 'B2', value: 5 }]

    const result = await apply.execute({ operations }, { signal: new AbortController().signal } as never)

    expect(approve).toHaveBeenCalledWith('apply_sheet_operations', { operations }, expect.anything())
    expect(request).toHaveBeenCalledWith('apply_ops', { ops: operations }, expect.anything())
    expect(result).toEqual(success)
    expect(JSON.stringify(result)).not.toContain('engine')
  })

  it('fails closed without dispatching a denied mutation', async () => {
    const request = vi.fn()
    const apply = createSheetsTools({
      request,
      approve: vi.fn().mockResolvedValue(false),
    })[1]!

    await expect(apply.execute({ operations: [{ op: 'set_cell' }] }, {
      signal: new AbortController().signal,
    } as never)).rejects.toThrow(/not approved/)
    expect(request).not.toHaveBeenCalled()
  })
})
