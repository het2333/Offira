import { afterEach, expect, it, vi } from 'vitest'
import { readIndexedWorkingCopyRange } from '../src/renderer/working-copy-hydration'
import { loadVisibleRange, preloadEntireWorkbook } from '../src/renderer/univer-sync'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function hydrationFixture() {
  const sheet = { id: 'sheet-1', name: 'Data', rowCount: 2, columnCount: 2 }
  const state = {
    file: { sessionId: 'native', sheets: [sheet] },
    loadedRanges: new Map(),
    loadingKeys: new Map(),
    retryTimers: new Map(),
    decorationsPendingSheets: new Set(),
    editJournal: { structuralOps: new Map() },
    flags: { preloadRunning: false, preloadComplete: false },
  }
  const worksheet = { getSheetId: () => 'sheet-1', getVisibleRange: () => null }
  const runtime = {
    univerAPI: {
      getActiveWorkbook: () => ({
        getSheetBySheetId: () => worksheet,
        getActiveSheet: () => worksheet,
      }),
    },
  }
  return { runtime, state, worksheet, ref: { current: state } }
}

it('propagates real viewport and preload HTTP failures without declaring data installed', async () => {
  const f = hydrationFixture()
  vi.stubGlobal('window', {
    desktopApi: {
      readWorkbookRange: async () => {
        throw Error('HTTP 503')
      },
    },
  })
  await expect(
    loadVisibleRange(
      f.runtime as never,
      f.ref as never,
      f.worksheet as never,
      () => {},
      undefined,
      true,
    ),
  ).rejects.toThrow('HTTP 503')
  await expect(
    preloadEntireWorkbook(f.runtime as never, f.ref as never, () => {}, true),
  ).rejects.toThrow('HTTP 503')
  expect(f.state.flags.preloadComplete).toBe(false)
  expect(f.state.loadedRanges.size).toBe(0)
})

it('keeps real viewport hydration pending while native indexing is incomplete', async () => {
  vi.useFakeTimers()
  const f = hydrationFixture()
  const read = vi.fn(async () => ({
    indexingComplete: false,
    indexedThroughRow: null,
    cells: [],
    rows: [],
    merges: [],
    hyperlinks: [],
    conditionalRules: [],
    dataValidations: [],
  }))
  vi.stubGlobal('window', { desktopApi: { readWorkbookRange: read } })
  const hydration = loadVisibleRange(
    f.runtime as never,
    f.ref as never,
    f.worksheet as never,
    () => {},
    undefined,
    true,
  )
  const rejected = expect(hydration).rejects.toThrow(/indexing/)
  await vi.runAllTimersAsync()
  await rejected
  expect(read).toHaveBeenCalledTimes(200)
  expect(f.state.loadedRanges.size).toBe(0)
})

it('propagates HTTP read errors instead of completing recovery', async () => {
  await expect(
    readIndexedWorkingCopyRange(
      async () => {
        throw Error('HTTP 503')
      },
      () => true,
    ),
  ).rejects.toThrow('HTTP 503')
})

it('does not resolve partial indexing and fails after the bounded retry budget', async () => {
  const read = vi.fn(async () => ({ indexingComplete: false, indexedThroughRow: 100 }))
  await expect(
    readIndexedWorkingCopyRange(read, () => true, { attempts: 3, delayMs: 0 }),
  ).rejects.toThrow(/indexing/)
  expect(read).toHaveBeenCalledTimes(3)
})

it('returns only the fully indexed data and refuses a replaced workbook', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ indexingComplete: false, cells: [] })
    .mockResolvedValueOnce({ indexingComplete: true, cells: ['restored'] })
  await expect(readIndexedWorkingCopyRange(read, () => true, { delayMs: 0 })).resolves.toEqual({
    indexingComplete: true,
    cells: ['restored'],
  })
  await expect(readIndexedWorkingCopyRange(read, () => false)).rejects.toThrow(/replaced/)
})
