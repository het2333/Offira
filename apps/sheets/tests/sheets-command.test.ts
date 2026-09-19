import { describe, expect, it, vi } from 'vitest'

import {
  executeSheetsCommand,
  type McpSheetHandlers,
} from '../src/renderer/agent/sheets-command'

function handlersWith(overrides: Partial<McpSheetHandlers> = {}): McpSheetHandlers {
  return {
    hasWorkbook: () => true,
    context: () => ({ sheets: [{ id: 'sheet-1', name: 'Summary' }] }),
    readCells: () => ({ A1: { value: 12 } }),
    sheets: () => [{ id: 'sheet-1', name: 'Summary' }],
    focusSheet: vi.fn(),
    applyOps: vi.fn().mockResolvedValue({ ok: true }),
    saveTo: vi.fn().mockResolvedValue({ ok: true, path: '/work/book.xlsx' }),
    saveInPlace: vi.fn().mockResolvedValue({ ok: true, path: '/work/book.xlsx' }),
    ...overrides,
  }
}

describe('executeSheetsCommand', () => {
  it('reads cells from a worksheet addressed by name', async () => {
    const readCells = vi.fn().mockReturnValue({ A1: { value: 12 } })
    const result = await executeSheetsCommand(handlersWith({ readCells }), {
      command: 'read_sheet',
      arguments: { sheet: 'summary', addresses: ['A1'] },
    })

    expect(result).toMatchObject({
      ok: true,
      data: { cells: { A1: { value: 12 } } },
      warnings: [],
    })
    expect(readCells).toHaveBeenCalledWith(['A1'], 'sheet-1')
  })

  it('returns a specific diagnostic for an invalid workbook operation', async () => {
    const applyOps = vi.fn()
    const result = await executeSheetsCommand(handlersWith({ applyOps }), {
      command: 'apply_ops',
      arguments: { ops: [{ op: 'set_cell', address: 'A1', value: 'x' }] },
    })

    expect(result.ok).toBe(false)
    expect(result.warnings[0]?.message).toContain('op #0 (set_cell)')
    expect(result.warnings[0]?.message).toContain('sheetId')
    expect(applyOps).not.toHaveBeenCalled()
  })

  it('plans a dry-run batch without committing it', async () => {
    const applyOps = vi.fn().mockResolvedValue({ ok: true, dryRun: true })
    const result = await executeSheetsCommand(handlersWith({ applyOps }), {
      command: 'apply_ops',
      arguments: {
        dryRun: true,
        ops: [{ op: 'set_cell', sheet: 'Summary', address: 'B2', value: 5 }],
      },
    })

    expect(result).toMatchObject({ ok: true, changes: { targets: ['Summary!B2'], count: 1 } })
    expect(applyOps).toHaveBeenCalledWith(
      [{ op: 'set_cell', sheetId: 'sheet-1', address: 'B2', value: 5 }],
      true,
    )
  })

  it('saves in place without accepting a model-chosen destination', async () => {
    const saveInPlace = vi.fn().mockResolvedValue({ ok: true, path: '/work/book.xlsx' })
    const saveTo = vi.fn()
    const result = await executeSheetsCommand(handlersWith({ saveInPlace, saveTo }), {
      command: 'save_sheet',
      arguments: { inPlace: true, path: '/untrusted/other.xlsx' },
    })

    expect(result).toMatchObject({ ok: true, summary: expect.stringContaining('/work/book.xlsx') })
    expect(saveInPlace).toHaveBeenCalledTimes(1)
    expect(saveTo).not.toHaveBeenCalled()
  })
})
