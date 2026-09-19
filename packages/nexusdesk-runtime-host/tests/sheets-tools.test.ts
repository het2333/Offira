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
      approve: vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' }),
    })

    expect(tools.map((tool) => tool.name)).toEqual([
      'read_sheet',
      'apply_sheet_operations',
      'save_sheet',
    ])
    expect(tools.some((tool) => tool.name.toLowerCase().includes('univer'))).toBe(false)
  })

  it('binds mutation approval to the exact semantic operation batch', async () => {
    const proposal = {
      ok: true,
      summary: 'Apply one operation.',
      warnings: [],
      data: {
        operationId: 'operation-1',
        planHash: 'plan-hash-1',
        summary: 'Apply one operation.',
        targets: ['Summary!B2'],
        warnings: [],
      },
    }
    const request = vi.fn().mockResolvedValueOnce(proposal).mockResolvedValueOnce(success)
    const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' })
    const apply = createSheetsTools({ request, approve })[1]!
    const operations = [{ op: 'set_cell', sheet: 'Summary', address: 'B2', value: 5 }]

    const result = await apply.execute({ operations }, {
      signal: new AbortController().signal,
    } as never)

    expect(request).toHaveBeenNthCalledWith(
      1,
      'propose_ops',
      { ops: operations },
      expect.anything(),
    )
    expect(approve).toHaveBeenCalledWith(
      'apply_sheet_operations',
      {
        operationId: 'operation-1',
        planHash: 'plan-hash-1',
        summary: 'Apply one operation.',
        targets: ['Summary!B2'],
        warnings: [],
      },
      expect.anything(),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'apply_ops',
      { ops: operations },
      expect.anything(),
      { approvalId: 'approval-1', planHash: 'plan-hash-1', operationId: 'operation-1' },
    )
    expect(result).toEqual(success)
    expect(JSON.stringify(result)).not.toContain('engine')
  })

  it('fails closed without dispatching a denied mutation', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'proposal',
      warnings: [],
      data: {
        operationId: 'operation-1',
        planHash: 'plan-hash-1',
        summary: 'proposal',
        targets: [],
      },
    })
    const apply = createSheetsTools({
      request,
      approve: vi.fn().mockResolvedValue({ approved: false }),
    })[1]!

    await expect(
      apply.execute({ operations: [{ op: 'set_cell' }] }, {
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow(/not approved/)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('propose_ops', expect.anything(), expect.anything())
  })
})
