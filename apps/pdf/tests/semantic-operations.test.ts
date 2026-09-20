import { describe, expect, it, vi } from 'vitest'
import { annotationOperations, imageOperations } from '../src/renderer/agent/semantic-operations'
import { buildNoteThreads } from '../src/renderer/note-threads'
import { planEditOps } from '../src/renderer/edit-ops'
import { PDF_WEB_IMAGE_BASE64_LIMIT } from '@nexusdesk/protocol'
import {
  PDF_WEB_CAPABILITIES,
  pdfCapabilities,
  parsePdfPageModification,
} from '../src/shared/web-capabilities'

const saved = {
  pageIndex: 0,
  objNum: 10,
  type: 'note' as const,
  rect: [0, 0, 20, 20] as [number, number, number, number],
  color: null,
  author: 'User',
  contents: 'Original',
  timeMs: null,
  inReplyTo: null,
}
const threads = buildNoteThreads(
  [saved, { ...saved, objNum: 11, contents: 'Reply', inReplyTo: 10 }],
  [],
)
const image = {
  pageIndex: 0,
  rect: [10, 20, 110, 70] as [number, number, number, number],
  aboveText: false,
}
const context = {
  readOnly: false,
  pageCount: 1,
  deleted: new Set<number>(),
  claimedImages: new Set<string>(),
}

describe('PDF semantic operation resolution', () => {
  it.each(['replace', 'bake'])(
    'rejects oversized %s pixels before a plan can be approved',
    async (action) => {
      const pixels = 'A'.repeat(PDF_WEB_IMAGE_BASE64_LIMIT + 4)
      await expect(
        imageOperations(
          { action, oldRect: image.rect, image: pixels, bake: 'opacity', alpha: 0.5 },
          0,
          [image],
          vi.fn().mockResolvedValue(pixels),
        ),
      ).rejects.toMatchObject({ code: 'PDF_PAYLOAD_TOO_LARGE' })
    },
  )
  it.each(['reply', 'edit', 'delete'])(
    'resolves saved note %s into valid canonical operations',
    (action) => {
      const ops = annotationOperations({ action, key: 'S10', text: 'Approved content' }, 0, threads)
      expect(planEditOps(ops, context, () => 'new-id').failures).toEqual([])
      if (action === 'reply')
        expect(ops[0]).toMatchObject({
          op: 'addDrawing',
          drawing: {
            replyToSaved: { objNum: 10, contents: 'Original' },
            contents: 'Approved content',
          },
        })
      if (action === 'edit')
        expect(ops[0]).toMatchObject({
          op: 'editSavedNote',
          annot: saved,
          contents: 'Approved content',
        })
      if (action === 'delete')
        expect(ops.map((op) => (op.annot as typeof saved).objNum)).toEqual([10, 11])
      expect(saved.contents).toBe('Original')
    },
  )

  it('resolves saved markup deletion and rejects missing or wrong-page keys', () => {
    expect(
      annotationOperations({ action: 'delete', key: 'S12' }, 0, [], {
        saved: { ...saved, objNum: 12, type: 'highlight' },
      }),
    ).toMatchObject([{ op: 'deleteSavedAnnot' }])
    expect(() =>
      annotationOperations({ action: 'reply', key: 'S99', text: 'reply' }, 0, threads),
    ).toThrow(/not found/)
  })

  it.each(['replace', 'delete', 'rotate', 'transform'])(
    'resolves image %s without applying before approval',
    async (action) => {
      const bake = vi.fn()
      const ops = await imageOperations(
        {
          action,
          oldRect: image.rect,
          image: 'aGVsbG8=',
          ...(action === 'transform' ? { rect: [20, 30, 120, 80] } : {}),
        },
        0,
        [image],
        bake,
      )
      expect(planEditOps(ops, context, () => 'new-id').failures).toEqual([])
      expect(bake).not.toHaveBeenCalled()
      if (action === 'rotate')
        expect(ops[0]).toMatchObject({ input: { quarterTurns: 1, rect: [35, -5, 85, 95] } })
      expect(image.rect).toEqual([10, 20, 110, 70])
    },
  )

  it.each([
    { bake: 'flip', axis: 'h' },
    { bake: 'opacity', alpha: 0.5 },
    { bake: 'cutout', tolerance: 30 },
    { bake: 'crop', crop: [0.1, 0.2, 0.9, 0.8] },
  ])('freezes $bake pixels into the approval plan', async (parameters) => {
    const bake = vi.fn().mockResolvedValue('aGVsbG8=')
    const ops = await imageOperations(
      { action: 'bake', oldRect: image.rect, ...parameters },
      0,
      [image],
      bake,
    )
    expect(bake).toHaveBeenCalledTimes(1)
    expect(ops[0]).toMatchObject({
      op: 'addImageEdit',
      input: { kind: 'replaceImage', image: 'aGVsbG8=' },
    })
    expect(planEditOps(ops, context, () => 'new-id').failures).toEqual([])
  })

  it('rejects invalid image references and bake arguments before approval', async () => {
    await expect(
      imageOperations({ action: 'delete', oldRect: image.rect }, 1, [image], vi.fn()),
    ).rejects.toThrow(/not found/)
    await expect(
      imageOperations(
        { action: 'bake', oldRect: image.rect, bake: 'opacity', alpha: 2 },
        0,
        [image],
        vi.fn(),
      ),
    ).rejects.toThrow(/Invalid/)
  })
})

describe('PDF Web capabilities and page contracts', () => {
  it('advertises implemented edits and explicitly gates native destination/dialog features', () => {
    const c = pdfCapabilities(PDF_WEB_CAPABILITIES)
    expect(c).toMatchObject({
      annotationEditing: true,
      imageEditing: true,
      pageRewriting: true,
      saveInPlace: true,
      nativeFileDialogs: false,
      saveAs: false,
      permanentRedaction: false,
      print: false,
      conversion: false,
    })
    expect(Object.values(pdfCapabilities({})).every((v) => !v)).toBe(true)
    expect(Object.values(pdfCapabilities()).every(Boolean)).toBe(true)
  })
  it.each([
    { action: 'insertBlankPage', afterPageIndex: -1 },
    { action: 'setPageSize', width: 300, height: 400 },
    { action: 'cropPages', pages: [0], rect: { l: 0.1, t: 0.1, r: 0.9, b: 0.9 } },
  ])('accepts the exact $action contract', (op) =>
    expect(parsePdfPageModification(op, 1)).toEqual(op),
  )
  it.each([
    { action: 'insertBlankPage', afterPageIndex: 1 },
    { action: 'setPageSize', width: NaN, height: 400 },
    { action: 'cropPages', pages: [0, 0], rect: { l: 0, t: 0, r: 1, b: 1 } },
    { action: 'cropPages', pages: [0], rect: { l: -1, t: 0, r: 1, b: 1 } },
  ])('rejects invalid $action rather than clamping', (op) =>
    expect(() => parsePdfPageModification(op, 1)).toThrow(),
  )
})
