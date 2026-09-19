import type { PageImageRef } from '../../shared/ipc'
import type { Op } from '../edit-ops'
import { flattenThread, threadSubtree, type NoteThreadItem } from '../note-threads'
import { cropRect, type ImageBakeOp } from '../image-bake'

type Rect = [number, number, number, number]
function rect(value: unknown): Rect {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    value[0] >= value[2] ||
    value[1] >= value[3]
  )
    throw new Error('Expected a finite, nonempty PDF-space rectangle')
  return value as Rect
}

export function annotationOperations(
  input: Record<string, unknown>,
  pageIndex: number,
  threads: NoteThreadItem[],
  markup?: { saved?: unknown; pendingId?: string },
): Op[] {
  const item = threads
    .flatMap((root) => flattenThread(root).map((v) => v.item))
    .find((item) => item.key === input.key)
  if (input.action === 'delete') {
    if (item) {
      const subtree = threadSubtree(item)
      return [
        ...subtree.saved.map((annot) => ({ op: 'deleteSavedAnnot', annot })),
        ...subtree.pendingIds.map((id) => ({ op: 'removeDrawing', id })),
      ]
    }
    if (markup?.saved) return [{ op: 'deleteSavedAnnot', annot: markup.saved }]
    if (markup?.pendingId) return [{ op: 'removeMarkup', id: markup.pendingId }]
  }
  if (!item) throw new Error('Annotation key was not found on the requested page')
  const contents = typeof input.text === 'string' ? input.text.trim() : ''
  if (!contents || contents.length > 24000)
    throw new Error('Annotation text must contain 1–24000 characters')
  if (input.action === 'edit') {
    if (item.saved) return [{ op: 'editSavedNote', annot: item.saved, contents, force: true }]
    if (item.pendingId) return [{ op: 'setNoteContents', id: item.pendingId, contents }]
  }
  if (input.action === 'reply') {
    return [
      {
        op: 'addDrawing',
        drawing: {
          kind: 'note',
          pageIndex,
          at: item.at,
          color: item.color ?? [1, 1, 0],
          contents,
          author: 'AI Assistant',
          ...(item.saved
            ? {
                replyToSaved: {
                  objNum: item.saved.objNum,
                  rect: item.saved.rect,
                  contents: item.saved.contents,
                },
              }
            : { replyToLocalId: item.pendingId }),
        },
      },
    ]
  }
  throw new Error('Annotation action must be reply, edit, or delete')
}

export function parseImageBake(input: Record<string, unknown>): ImageBakeOp {
  if (input.bake === 'flip' && (input.axis === 'h' || input.axis === 'v'))
    return { kind: 'flip', axis: input.axis }
  if (
    input.bake === 'opacity' &&
    typeof input.alpha === 'number' &&
    Number.isFinite(input.alpha) &&
    input.alpha >= 0 &&
    input.alpha <= 1
  )
    return { kind: 'opacity', alpha: input.alpha }
  if (
    input.bake === 'cutout' &&
    typeof input.tolerance === 'number' &&
    Number.isFinite(input.tolerance) &&
    input.tolerance >= 0 &&
    input.tolerance <= 100
  )
    return { kind: 'cutout', tolerance: input.tolerance }
  if (input.bake === 'crop') {
    const [l, t, r, b] = rect(input.crop)
    if (l >= 0 && t >= 0 && r <= 1 && b <= 1) return { kind: 'crop', crop: { l, t, r, b } }
  }
  throw new Error('Invalid image bake parameters')
}

/** Resolves references and bakes pixels before approval; never mutates the working copy. */
export async function imageOperations(
  input: Record<string, unknown>,
  pageIndex: number,
  images: PageImageRef[],
  bake: (ref: PageImageRef, op: ImageBakeOp) => Promise<string | null>,
): Promise<Op[]> {
  const oldRect = rect(input.oldRect)
  const ref = images.find(
    (ref) =>
      ref.pageIndex === pageIndex && ref.rect.every((v, i) => Math.abs(v - oldRect[i]!) < 0.01),
  )
  if (!ref) throw new Error('Image was not found on the requested page; list images again')
  const base = { pageIndex, oldRect: ref.rect }
  const action = input.action ?? 'transform'
  if (action === 'delete') return [{ op: 'addImageEdit', input: { kind: 'deleteImage', ...base } }]
  if (action === 'replace' || action === 'bake') {
    const op = action === 'bake' ? parseImageBake(input) : undefined
    const image = op ? await bake(ref, op) : input.image
    if (
      typeof image !== 'string' ||
      !image ||
      image.length > 24 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/=]+$/.test(image)
    )
      throw new Error('Image pixels are unavailable or invalid; provide PNG base64')
    return [
      {
        op: 'addImageEdit',
        origAbove: ref.aboveText,
        input: {
          kind: 'replaceImage',
          ...base,
          rect: op?.kind === 'crop' ? cropRect(ref.rect, op.crop) : ref.rect,
          image,
        },
      },
    ]
  }
  if (action !== 'transform' && action !== 'rotate') throw new Error('Unknown image action')
  const turns = input.quarterTurns ?? (action === 'rotate' ? 1 : 0)
  if (!Number.isInteger(turns) || Number(turns) < 0 || Number(turns) > 3)
    throw new Error('quarterTurns must be 0–3')
  const r = input.rect === undefined ? ([...ref.rect] as Rect) : rect(input.rect)
  if (
    action === 'transform' &&
    input.rect === undefined &&
    input.quarterTurns === undefined &&
    input.layer === undefined
  )
    throw new Error('Provide a rectangle, rotation, or layer')
  if (input.rect === undefined && Number(turns) % 2) {
    const cx = (r[0] + r[2]) / 2,
      cy = (r[1] + r[3]) / 2,
      w = (r[2] - r[0]) / 2,
      h = (r[3] - r[1]) / 2
    r.splice(0, 4, cx - h, cy - w, cx + h, cy + w)
  }
  if (input.layer !== undefined && input.layer !== 'aboveText' && input.layer !== 'belowText')
    throw new Error('Invalid image layer')
  return [
    {
      op: 'addImageEdit',
      origAbove: ref.aboveText,
      input: {
        kind: 'transformImage',
        ...base,
        rect: r,
        quarterTurns: turns,
        ...(input.layer === undefined ? {} : { layer: input.layer }),
      },
    },
  ]
}
