// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SavePdfRequest } from '../src/shared/ipc'
import { runEditOps } from '../src/renderer/edit-ops'
import type { EditSnapshot } from '../src/renderer/edit-state'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg=='
const request = (over: Partial<SavePdfRequest> = {}): SavePdfRequest => ({
  path: 'nexusdesk://pdf',
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  ...over,
})

describe('PDF working-copy capture', () => {
  it('captures the exact saved ids and page remap so late edits survive a page-rewrite rebase', async () => {
    const module = await import('../src/renderer/agent/pdf-working-copy')
    expect(module.pdfSavedSnapshot).toBeTypeOf('function')
    const state: EditSnapshot = {
      markups: [{ id: 'approved', pageIndex: 2, type: 'highlight', color: [1, 1, 0], quads: [] }],
      annotDeletes: [],
      drawings: [],
      noteEdits: [],
      textEdits: [],
      textInserts: [],
      imageEdits: [],
      stampCfg: null,
      formEdits: new Map(),
      rotations: new Map([[2, 90]]),
      deleted: new Set([1]),
      order: [2, 0],
      metadata: null,
    }
    const saved = module.pdfSavedSnapshot(state, 3, {
      action: 'insertBlankPage',
      afterPageIndex: 0,
    })
    state.markups.push({ ...state.markups[0]!, id: 'late' })
    expect([...saved.markupIds]).toEqual(['approved'])
    expect([...saved.pageMap]).toEqual([
      [2, 0],
      [0, 2],
    ])
    expect(saved.rotations.get(2)).toBe(90)
  })
  it('omits unchanged static-form metadata so recovery Save can promote the exact source bytes', async () => {
    const { buildPdfSaveRequest } = await import('../src/renderer/agent/pdf-working-copy')
    const state: EditSnapshot = {
      markups: [],
      annotDeletes: [],
      drawings: [],
      noteEdits: [],
      textEdits: [],
      textInserts: [],
      imageEdits: [],
      stampCfg: null,
      formEdits: new Map(),
      rotations: new Map(),
      deleted: new Set(),
      order: null,
      metadata: null,
    }
    const result = buildPdfSaveRequest(state, {
      path: '',
      pageCount: 1,
      savedStaticFormFills: [
        { id: 'fill', kind: 'text', pageIndex: 0, rect: [1, 1, 10, 10], text: 'Ada' },
      ],
      renderStamps: () => [],
    })
    expect(result.staticFormFills).toBeUndefined()
  })
  it('builds the save plan from the exact reducer post-state before any render', async () => {
    const module = await import('../src/renderer/agent/pdf-working-copy')
    expect(module.buildPdfSaveRequest).toBeTypeOf('function')
    const state: EditSnapshot = {
      markups: [],
      annotDeletes: [],
      drawings: [],
      noteEdits: [],
      textEdits: [],
      textInserts: [
        {
          id: 'manual',
          input: { pageIndex: 0, origin: [40, 40], text: 'Manual', fontSize: 12, color: [0, 0, 0] },
        },
      ],
      imageEdits: [],
      stampCfg: null,
      formEdits: new Map(),
      rotations: new Map(),
      deleted: new Set(),
      order: null,
      metadata: null,
    }
    const { state: post } = runEditOps(
      state,
      [
        {
          op: 'addMarkup',
          markup: {
            pageIndex: 0,
            type: 'highlight',
            color: [1, 1, 0],
            quads: [[10, 20, 30, 20, 10, 10, 30, 10]],
          },
        },
        { op: 'rotatePages', pages: [0], dir: 90 },
        { op: 'setPageOrder', order: [1, 0] },
      ],
      { readOnly: false, pageCount: 2, deleted: new Set(), claimedImages: new Set() },
      () => 'agent-mark',
    )
    const payload = module.buildPdfSaveRequest(post, {
      path: 'nexusdesk://pdf',
      pageCount: 2,
      savedStaticFormFills: [],
      renderStamps: () => [],
    })
    expect(payload.textInserts?.[0]?.text).toBe('Manual')
    expect(payload.markups).toHaveLength(1)
    expect(payload.rotations).toEqual([{ pageIndex: 0, delta: 90 }])
    expect(payload.pageOrder).toEqual([1, 0])
    expect(state.markups).toHaveLength(0)
  })
  it('freezes post-state and moves every image to a raw asset part', async () => {
    const module = await import('../src/renderer/agent/pdf-working-copy').catch(() => null)
    expect(module?.capturePdfWorkingCopy).toBeTypeOf('function')
    if (!module) return
    const input = request({
      textInserts: [
        { pageIndex: 0, origin: [20, 20], text: 'Manual', fontSize: 12, color: [0, 0, 0] },
      ],
      drawings: [{ kind: 'image', pageIndex: 0, image: png, rect: [0, 0, 10, 10] }],
      stamps: [{ pageIndex: 0, image: png, rect: [10, 0, 20, 10] }],
      imageEdits: [
        {
          kind: 'insertImage',
          pageIndex: 0,
          image: png,
          rect: [20, 0, 30, 10],
          layer: 'aboveText',
        },
      ],
    })
    const payload = module.capturePdfWorkingCopy(input)
    input.textInserts![0]!.text = 'Changed after capture'
    const parts = new Map(
      await Promise.all(
        [...payload.parts].map(
          async ([key, value]) => [key, new Uint8Array(await value.arrayBuffer())] as const,
        ),
      ),
    )
    const { decodePdfWorkingCopy } = await import('../src/shared/working-copy')
    const decoded = decodePdfWorkingCopy(parts)
    expect(decoded.request.textInserts?.[0]?.text).toBe('Manual')
    expect(decoded.request.imageEdits?.[0]).toMatchObject({ image: png })
    expect(decoded.request.stamps[0]).toMatchObject({ image: png })
    expect(decoded.request.drawings[0]).toMatchObject({ image: png })
    const jsonParts = [...parts].filter(([key]) => !key.startsWith('asset-'))
    for (const [, bytes] of jsonParts) expect(new TextDecoder().decode(bytes)).not.toContain(png)
    expect([...parts].filter(([key]) => key.startsWith('asset-'))).toHaveLength(3)
  })

  it('bounds UTF-8 JSON parts and rejects an indivisible oversized record', async () => {
    const module = await import('../src/renderer/agent/pdf-working-copy').catch(() => null)
    expect(module?.capturePdfWorkingCopy).toBeTypeOf('function')
    if (!module) return
    const notes = Array.from({ length: 150 }, (_, i) => ({
      kind: 'note' as const,
      pageIndex: 0,
      color: [1, 0, 0] as [number, number, number],
      at: [20, i] as [number, number],
      contents: '字'.repeat(900),
    }))
    const payload = module.capturePdfWorkingCopy(request({ drawings: notes }))
    for (const [key, blob] of payload.parts)
      if (!key.startsWith('asset-')) expect(blob.size).toBeLessThanOrEqual(262144)
    expect(() =>
      module.capturePdfWorkingCopy(
        request({ drawings: [{ ...notes[0]!, contents: '字'.repeat(100000) }] }),
      ),
    ).toThrow(/record|part/i)
  })
})
