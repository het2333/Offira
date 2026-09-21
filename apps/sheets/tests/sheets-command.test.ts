import { describe, expect, it, vi } from 'vitest'

import { executeSheetsCommand, type McpSheetHandlers } from '../src/renderer/agent/sheets-command'

function handlersWith(overrides: Partial<McpSheetHandlers> = {}): McpSheetHandlers {
  return {
    hasWorkbook: () => true,
    context: () => ({ sheets: [{ id: 'sheet-1', name: 'Summary' }] }),
    readCells: () => ({ A1: { value: 12 } }),
    ensureCellsLoaded: vi.fn().mockResolvedValue(true),
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

  it('expands ranges into individual cell results', async () => {
    const readCells = vi.fn().mockReturnValue({
      C1: { value: 1 },
      C2: { value: 2 },
      C3: { value: 3 },
    })
    const result = await executeSheetsCommand(handlersWith({ readCells }), {
      command: 'read_sheet',
      arguments: { sheetId: 'sheet-1', addresses: ['C1:C3'] },
    })

    expect(result).toMatchObject({
      ok: true,
      data: { cells: { C1: { value: 1 }, C2: { value: 2 }, C3: { value: 3 } } },
    })
    expect(readCells).toHaveBeenCalledWith(['C1', 'C2', 'C3'], 'sheet-1')
  })

  it('waits for lazy cells to load before reading them', async () => {
    let releaseLoad: (() => void) | undefined
    const ensureCellsLoaded = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseLoad = () => resolve(true)
        }),
    )
    const readCells = vi.fn().mockReturnValue({ C1: { value: 1 } })
    const pending = executeSheetsCommand(handlersWith({ ensureCellsLoaded, readCells }), {
      command: 'read_sheet',
      arguments: { sheetId: 'sheet-1', addresses: ['C1'] },
    })

    await Promise.resolve()
    expect(readCells).not.toHaveBeenCalled()
    releaseLoad?.()
    await pending
    expect(readCells).toHaveBeenCalledTimes(1)
  })

  it('returns an error instead of fake empty cells when loading fails', async () => {
    const readCells = vi.fn()
    const result = await executeSheetsCommand(
      handlersWith({
        ensureCellsLoaded: vi.fn().mockRejectedValue(new Error('range stream failed')),
        readCells,
      }),
      { command: 'read_sheet', arguments: { sheetId: 'sheet-1', addresses: ['C1'] } },
    )

    expect(result).toMatchObject({ ok: false, warnings: [{ message: 'range stream failed' }] })
    expect(readCells).not.toHaveBeenCalled()
  })

  it('preserves formula, computed value, and raw value', async () => {
    const result = await executeSheetsCommand(
      handlersWith({
        readCells: vi.fn().mockReturnValue({
          C1: { value: 3, rawValue: 3, formula: '=SUM(A1:B1)' },
        }),
      }),
      {
        command: 'read_sheet',
        arguments: { sheetId: 'sheet-1', addresses: ['C1'] },
      },
    )

    expect(result).toMatchObject({
      ok: true,
      data: { cells: { C1: { value: 3, rawValue: 3, formula: '=SUM(A1:B1)' } } },
    })
  })

  it('rejects an explicit worksheet id that does not exist', async () => {
    const readCells = vi.fn()
    const result = await executeSheetsCommand(handlersWith({ readCells }), {
      command: 'read_sheet',
      arguments: { sheetId: 'missing', addresses: ['A1'] },
    })

    expect(result).toMatchObject({ ok: false, warnings: [{ code: 'SHEET_NOT_FOUND' }] })
    expect(readCells).not.toHaveBeenCalled()
  })

  it('rejects conflicting explicit worksheet name and id', async () => {
    const readCells = vi.fn()
    const result = await executeSheetsCommand(
      handlersWith({
        sheets: () => [
          { id: 'sheet-1', name: 'Summary' },
          { id: 'sheet-2', name: 'Details' },
        ],
        readCells,
      }),
      {
        command: 'read_sheet',
        arguments: { sheet: 'Summary', sheetId: 'sheet-2', addresses: ['A1'] },
      },
    )

    expect(result).toMatchObject({ ok: false, warnings: [{ code: 'SHEET_NOT_FOUND' }] })
    expect(readCells).not.toHaveBeenCalled()
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

    expect(result).toMatchObject({
      ok: true,
      summary: expect.stringContaining('/work/book.xlsx'),
      data: { ok: true, path: '/work/book.xlsx' },
    })
    expect(saveInPlace).toHaveBeenCalledTimes(1)
    expect(saveTo).not.toHaveBeenCalled()
  })
})
