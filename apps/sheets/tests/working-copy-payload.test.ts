import { describe, expect, it } from 'vitest'
import {
  buildWorkingCopyPayload,
  encodeWorkbookSaveRequest,
  decodeWorkbookSaveRequest,
  assertWorkingCopyOperationsPersistable,
} from '../src/renderer/working-copy-payload'
import { createEditJournal, recordSetRangeValues } from '../src/renderer/edit-journal'
import type { SaveContext } from '../src/renderer/save-actions'
import type { WorkbookSaveRequest } from '../src/shared/desktop-api'

function emptySaveRequest(): WorkbookSaveRequest {
  return {
    sessionId: '5d4f6f7a-1c2b-4e3d-9a8f-0b1c2d3e4f5a',
    mode: 'save',
    restoreWriteBack: true,
    edits: [],
    structuralOps: [],
    chartEdits: [],
    visualEdits: [],
    visualAdditions: [],
    tableAdditions: [],
    pivotAdditions: [],
    sheetOps: [],
    sheetOrder: [],
    filterStates: [],
    hyperlinkEdits: [],
    cfStates: [],
    dvStates: [],
    pageSetupStates: [],
    noteStates: [],
    formulaValues: [],
    pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [],
    sheetProtections: [],
    sparklineAdditions: [],
    definedNamesState: null,
    themeState: null,
    workbookProtectionState: null,
    protectedRangeStates: [],
  }
}

describe('working copy payload', () => {
  it('refuses new-sheet pivot plans before they can create an unpersistable held operation', () => {
    const journal = createEditJournal()
    journal.sheets.added.set('new', { name: 'New' })
    const ctx = { lazyWorkbookRef: { current: { editJournal: journal } } } as unknown as SaveContext
    expect(() =>
      assertWorkingCopyOperationsPersistable(ctx, [{ op: 'add_pivot', sheetId: 'new' }]),
    ).toThrow(/save.*reload|Save.*reload/)
    expect(() =>
      assertWorkingCopyOperationsPersistable(ctx, [
        { op: 'insert_rows', sheetId: 'old' },
        { op: 'add_table', sheetId: 'new' },
      ]),
    ).toThrow(/save.*reload|Save.*reload/)
    expect(() =>
      assertWorkingCopyOperationsPersistable(ctx, [{ op: 'add_table', sheetId: 'old' }]),
    ).not.toThrow()
  })
  it('captures without touching the session, journal, desktop transport or UI', async () => {
    const journal = createEditJournal()
    recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'captured' } } })
    const fail = () => {
      throw new Error('capture must not invoke UI or disk save')
    }
    const ctx = {
      univerRef: { current: null },
      lazyWorkbookRef: {
        current: {
          file: { sessionId: '5d4f6f7a-1c2b-4e3d-9a8f-0b1c2d3e4f5a' },
          editJournal: journal,
        },
      },
      setMessage: fail,
      openLazyWorkbook: fail,
      stashViewRestore: fail,
    } as unknown as SaveContext
    const payload = await buildWorkingCopyPayload(ctx)
    const parts = new Map(
      await Promise.all(
        [...payload.parts].map(
          async ([id, blob]) => [id, new Uint8Array(await blob.arrayBuffer())] as const,
        ),
      ),
    )
    expect(decodeWorkbookSaveRequest(parts).edits).toMatchObject([
      { sheetId: 'sheet-1', value: 'captured' },
    ])
    expect(journal.cells.get('sheet-1')?.size).toBe(1)
  })

  it('round trips more than the inline edit cap and 2 MB through UTF-8 bounded parts', async () => {
    const request = emptySaveRequest()
    request.edits = Array.from({ length: 21_001 }, (_, row) => ({
      sheetId: 'sheet-1',
      row,
      column: 0,
      writeValue: true,
      value: '中文😀'.repeat(12),
    }))
    const payload = encodeWorkbookSaveRequest(request)
    let total = 0
    const parts = new Map<string, Uint8Array>()
    for (const [id, blob] of payload.parts) {
      expect(blob.size).toBeLessThanOrEqual(262_144)
      total += blob.size
      parts.set(id, new Uint8Array(await blob.arrayBuffer()))
    }
    expect(total).toBeGreaterThan(2_000_000)
    expect(decodeWorkbookSaveRequest(parts).edits).toHaveLength(21_001)
    expect(decodeWorkbookSaveRequest(parts).edits[21_000]?.value).toBe('中文😀'.repeat(12))
  })

  it('rejects an indivisible oversized metadata record', () => {
    const request = emptySaveRequest()
    request.noteStates = [
      {
        sheetId: 'sheet-1',
        notes: [{ row: 0, column: 0, text: '中'.repeat(100_000), author: 'Me' }],
      },
    ] as never
    expect(() => encodeWorkbookSaveRequest(request)).toThrow(/256 KiB/)
  })

  it('chunks growing nested metadata lists and carries images as raw asset parts', async () => {
    const request = emptySaveRequest()
    request.noteStates = [
      {
        sheetId: 'sheet-1',
        notes: Array.from({ length: 600 }, (_, row) => ({
          row,
          column: 0,
          text: '中'.repeat(500),
          author: 'Me',
        })),
      },
    ]
    request.visualAdditions = [
      {
        sheetId: 'sheet-1',
        anchor: {
          fromRow: 0,
          fromColumn: 0,
          fromRowOffset: 0,
          fromColumnOffset: 0,
          toRow: 1,
          toColumn: 1,
          toRowOffset: 0,
          toColumnOffset: 0,
        },
        image: { mediaType: 'image/png', base64: btoa('raw-image-bytes') },
      },
    ]
    const payload = encodeWorkbookSaveRequest(request)
    const parts = new Map<string, Uint8Array>()
    for (const [id, blob] of payload.parts) {
      parts.set(id, new Uint8Array(await blob.arrayBuffer()))
      if (id.startsWith('asset-')) expect(await blob.text()).toBe('raw-image-bytes')
      else {
        expect(blob.size).toBeLessThanOrEqual(262_144)
        expect(await blob.text()).not.toContain(btoa('raw-image-bytes'))
      }
    }
    const restored = decodeWorkbookSaveRequest(parts)
    expect(restored.noteStates[0]?.notes).toHaveLength(600)
    expect(restored.visualAdditions[0]?.image?.base64).toBe(btoa('raw-image-bytes'))
  })
})
