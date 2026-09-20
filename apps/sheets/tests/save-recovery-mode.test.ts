/**
 * A dirty workbook gets a crash-recovery copy through the
 * same save pipeline, but recovery mode must never touch the opened file, prompt,
 * or clear the journal — the whole point is that unsaved work survives a crash.
 */
import JSZip from 'jszip'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { applyCellEditsToXlsx } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { handleSave, type SaveContext } from '../src/renderer/save-actions'
import {
  createEditJournal,
  recordSetRangeValues,
  recordStructuralOp,
  recordTableAdd,
} from '../src/renderer/edit-journal'
import { buildEditFixture } from './fixture-builder'
import { isApprovedSaveLocked } from '../src/renderer/approved-save-lock'
import type { UniverRuntime } from '../src/renderer/univer-state'
import { aiBulkUndoGate } from '../src/renderer/univer-state'

const saveWorkbookEdits = vi.fn()
const writeWorkbookRecovery = vi.fn()

beforeEach(() => {
  saveWorkbookEdits.mockReset().mockResolvedValue({ canceled: true })
  writeWorkbookRecovery.mockReset().mockResolvedValue({ ok: true })
  ;(globalThis as unknown as { window: unknown }).window = {
    desktopApi: { saveWorkbookEdits, writeWorkbookRecovery },
  }
})

function ctxWith(opts: { dirty: boolean; needsSaveAs?: boolean; restoredFromRecovery?: boolean }): {
  ctx: SaveContext
  messages: string[]
  journal: ReturnType<typeof createEditJournal>
  overlay: Map<string, Map<string, { v?: string | number | boolean | null }>>
} {
  const journal = createEditJournal()
  if (opts.dirty) recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'edited' } } })
  const messages: string[] = []
  const overlay = new Map<string, Map<string, { v?: string | number | boolean | null }>>()
  return {
    messages,
    journal,
    overlay,
    ctx: {
      univerRef: { current: null },
      stashViewRestore: () => {},
      lazyWorkbookRef: {
        current: {
          editJournal: journal,
          recalc: {
            timer: null,
            generation: 0,
            failed: false,
            formulaCells: new Map(),
            overlay,
          },
          file: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            needsSaveAs: !!opts.needsSaveAs,
            restoredFromRecovery: !!opts.restoredFromRecovery,
          },
        },
      } as never,
      setMessage: (m: string) => messages.push(m),
      openLazyWorkbook: () => {},
    },
  }
}

describe('handleSave recovery mode', () => {
  it('refuses an approved save while an asynchronous edit batch is in flight', async () => {
    const { ctx } = ctxWith({ dirty: true })
    ctx.approvedSaveGuard = () => true
    aiBulkUndoGate.active = true
    try {
      await expect(handleSave(ctx, 'save-as', true)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('still applying edits'),
      })
      expect(saveWorkbookEdits).not.toHaveBeenCalled()
    } finally {
      aiBulkUndoGate.active = false
    }
  })
  it.each([false, true])(
    'finishes the approved two-phase transaction and adopts the written session (second failure: %s)',
    async (failSecond) => {
      const { ctx, journal } = ctxWith({ dirty: true })
      recordStructuralOp(journal, 'sheet-1', { kind: 'insert-rows', index: 0, count: 1 })
      recordTableAdd(journal, {
        sheetId: 'sheet-1',
        name: 'ApprovedTable',
        area: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 },
        columnNames: ['Approved'],
        bandedRows: true,
      })
      let current = true
      let beforeCommand: ((command: { id: string }) => void) | undefined
      const dispose = vi.fn(() => {
        beforeCommand = undefined
      })
      const runtime = {
        univer: {
          __getInjector: () => ({
            get: () => ({
              beforeCommandExecuted: (fn: typeof beforeCommand) => {
                beforeCommand = fn
                return { dispose }
              },
            }),
          }),
        },
        univerAPI: { getActiveWorkbook: () => null },
      } as unknown as UniverRuntime
      ctx.univerRef = { current: runtime }
      const firstFile = { sessionId: 'first-written', path: '/tmp/approved.xlsx' }
      const secondFile = { sessionId: 'second-written', path: '/tmp/approved.xlsx' }
      ctx.openLazyWorkbook = vi.fn(() => {
        expect(isApprovedSaveLocked(runtime)).toBe(false)
      })
      ctx.approvedSaveGuard = () => current
      saveWorkbookEdits
        .mockImplementationOnce(async () => {
          // Host bookkeeping changes on the first write; it cannot cancel the
          // already-started transaction or leave the editor on the obsolete session.
          current = false
          expect(isApprovedSaveLocked(runtime)).toBe(true)
          expect(() => beforeCommand!({ id: 'sheet.mutation.set-range-values' })).toThrow(
            /approved save/i,
          )
          journal.tableAdds[0]!.columnNames[0] = 'late mutable reference'
          return { canceled: false, file: firstFile }
        })
        .mockImplementationOnce(async () => {
          expect(isApprovedSaveLocked(runtime)).toBe(true)
          if (failSecond) throw Error('second write failed')
          return { canceled: false, file: secondFile }
        })
      const result = await handleSave(ctx, 'save-as', true, {
        path: '/tmp/approved.xlsx',
        overwrite: true,
      })
      expect(saveWorkbookEdits).toHaveBeenCalledTimes(2)
      expect(saveWorkbookEdits.mock.calls[1]![0]).toMatchObject({
        sessionId: 'first-written',
        tableAdditions: [{ columnNames: ['Approved'] }],
      })
      expect(ctx.openLazyWorkbook).toHaveBeenCalledWith(failSecond ? firstFile : secondFile)
      expect(result.ok).toBe(!failSecond)
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(isApprovedSaveLocked(runtime)).toBe(false)
    },
  )

  it('refuses the write when approved content changes during async edit staging', async () => {
    const { ctx, journal } = ctxWith({ dirty: true })
    const snapshot = () =>
      JSON.stringify(journal.cells, (_key, value) => (value instanceof Map ? [...value] : value))
    const approved = snapshot()
    const guarded = { ...ctx, approvedSaveGuard: () => snapshot() === approved }
    const saving = handleSave(guarded, 'save-as', true, {
      path: '/tmp/approved.xlsx',
      overwrite: true,
    })
    recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'changed after approval' } } })
    await expect(saving).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('STALE_CONTENT'),
    })
    expect(saveWorkbookEdits).not.toHaveBeenCalled()
  })

  it('writes a recovery copy and never the opened file', async () => {
    const { ctx, messages } = ctxWith({ dirty: true })
    await handleSave(ctx, 'recovery')
    expect(writeWorkbookRecovery).toHaveBeenCalledTimes(1)
    expect(saveWorkbookEdits).not.toHaveBeenCalled()
    // silent: no status messages for a background copy
    expect(messages).toEqual([])
  })

  it('sends the same payload shape the save pipeline gets', async () => {
    const { ctx } = ctxWith({ dirty: true })
    await handleSave(ctx, 'recovery')
    const payload = writeWorkbookRecovery.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.sessionId).toBe('11111111-1111-4111-8111-111111111111')
    // 'recovery' is a renderer-side mode; the main process still sees a normal save request
    expect(payload.mode).toBe('save')
    expect(Array.isArray(payload.edits)).toBe(true)
    expect((payload.edits as unknown[]).length).toBe(1)
    expect(payload).toHaveProperty('structuralOps')
    expect(payload).toHaveProperty('sparklineAdditions')
  })

  it('does nothing when there is nothing pending', async () => {
    const { ctx, messages } = ctxWith({ dirty: false })
    await handleSave(ctx, 'recovery')
    expect(writeWorkbookRecovery).not.toHaveBeenCalled()
    expect(messages).toEqual([])
  })

  it('a failed copy is swallowed (best-effort, never surfaces; resolves not-ok)', async () => {
    writeWorkbookRecovery.mockRejectedValue(new Error('disk full'))
    const { ctx, messages } = ctxWith({ dirty: true })
    // handleSave now reports an outcome (the MCP bridge reads it); recovery
    // mode still stays silent on failure
    await expect(handleSave(ctx, 'recovery')).resolves.toEqual({ ok: false })
    expect(messages).toEqual([])
  })
})

describe('handleSave formula cache overlay', () => {
  it('never pairs an immediately saved replacement formula with the previous cached value', async () => {
    const { ctx, journal, overlay } = ctxWith({ dirty: false })
    recordSetRangeValues(journal, 'sheet-1', { 2: { 1: { f: '=2+2' } } })
    overlay.set(
      'sheet-1',
      new Map([
        // B3 used to be SUM(C1:C2), whose cached value was 5.
        ['2:1', { v: 5 }],
        ['0:2', { v: 7 }],
      ]),
    )
    let savedWorksheet = ''
    saveWorkbookEdits.mockImplementationOnce(async (payload) => {
      const request = payload as {
        edits: {
          row: number
          column: number
          writeValue: boolean
          value: string | number | boolean | null
          formula?: string
        }[]
        formulaValues: {
          sheetId: string
          row: number
          column: number
          value: string | number | boolean | null
        }[]
      }
      const mutation = await applyCellEditsToXlsx(
        await buildEditFixture(),
        request.edits.map((edit) => ({
          sheetName: 'Data',
          row: edit.row,
          column: edit.column,
          writeValue: edit.writeValue,
          cell: {
            value: edit.value,
            ...(edit.formula === undefined ? {} : { formula: edit.formula }),
          },
        })),
        [],
        [],
        undefined,
        [],
        [],
        [],
        [],
        [],
        null,
        [],
        [],
        [
          {
            sheetName: 'Data',
            cells: request.formulaValues.map(({ row, column, value }) => ({
              row,
              column,
              value,
            })),
          },
        ],
      )
      const zip = await JSZip.loadAsync(mutation.buffer)
      savedWorksheet = await zip.file('xl/worksheets/sheet1.xml')!.async('text')
      return { canceled: true }
    })

    await handleSave(ctx, 'save')

    const payload = saveWorkbookEdits.mock.calls[0]![0] as {
      edits: { row: number; column: number; formula?: string }[]
      formulaValues: { row: number; column: number; value: unknown }[]
    }
    expect(payload.edits).toContainEqual(
      expect.objectContaining({ row: 2, column: 1, formula: '=2+2' }),
    )
    expect(payload.formulaValues).toEqual([{ sheetId: 'sheet-1', row: 0, column: 2, value: 7 }])
    const savedB3 = /<c r="B3"[^>]*>[\s\S]*?<\/c>/.exec(savedWorksheet)?.[0]
    expect(savedB3).toContain('<f>2+2</f>')
    expect(savedB3).not.toContain('<v>')
  })

  it("never writes IronCalc's #ERROR! into a cached <v> (issue 235)", async () => {
    const { ctx, journal, overlay } = ctxWith({ dirty: false })
    recordSetRangeValues(journal, 'sheet-1', { 5: { 5: { v: 1 } } })
    overlay.set(
      'sheet-1',
      new Map([
        ['0:0', { v: '#ERROR!' }],
        ['0:1', { v: '#N/A' }],
        ['0:2', { v: 7 }],
      ]),
    )
    await handleSave(ctx, 'save')
    const payload = saveWorkbookEdits.mock.calls[0]![0] as {
      formulaValues: { row: number; column: number; value: unknown }[]
    }
    expect(payload.formulaValues).toEqual([
      { sheetId: 'sheet-1', row: 0, column: 1, value: '#N/A' },
      { sheetId: 'sheet-1', row: 0, column: 2, value: 7 },
    ])
  })
})

describe('handleSave restored-recovery write-back', () => {
  it('a clean restored session still saves: the workbook bytes are the change', async () => {
    const { ctx } = ctxWith({ dirty: false, restoredFromRecovery: true })
    await handleSave(ctx, 'save')
    expect(saveWorkbookEdits).toHaveBeenCalledTimes(1)
    const payload = saveWorkbookEdits.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.mode).toBe('save')
    expect(payload.restoreWriteBack).toBe(true)
  })

  it('a clean ordinary session still refuses a pointless save', async () => {
    const { ctx, messages } = ctxWith({ dirty: false })
    await handleSave(ctx, 'save')
    expect(saveWorkbookEdits).not.toHaveBeenCalled()
    expect(messages.length).toBe(1)
  })

  it('never flags recovery-mode writes as a restore write-back', async () => {
    const { ctx } = ctxWith({ dirty: true, restoredFromRecovery: true })
    await handleSave(ctx, 'recovery')
    expect(writeWorkbookRecovery).toHaveBeenCalledTimes(1)
    const payload = writeWorkbookRecovery.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.restoreWriteBack).toBeUndefined()
  })
})
