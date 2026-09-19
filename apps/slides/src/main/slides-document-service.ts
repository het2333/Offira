import {
  commitSaved,
  copyElementData,
  openPptx,
  savePptx,
  type ElementClipboardItem,
  type OpenedPptx,
} from '@genoffice/pptx-engine'
import { runTxn, type Op, type TxnRequest, type TxnResult } from '@genoffice/pptx-ops'
import { buildRenderSlide, type RenderSlide } from '@genoffice/pptx-render'

import type { ApplyTxnOp, ApplyTxnResult, EditTextOp, OpenResult } from '../shared/ipc'

const EMU_PER_PX_96 = 9_525
const EMU_PER_PT = 12_700

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Slides UI operation payload must be an object.')
  }
  return value as Record<string, unknown>
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer.`)
  return value
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite.`)
  return value
}

function render(opened: OpenedPptx, fitWidthPx: number): RenderSlide[] {
  return opened.deck.slides.map((slide, index) =>
    buildRenderSlide(slide, opened.deck.size, { fitWidthPx, slideNo: index + 1 }),
  )
}

function compact(result: TxnResult): Array<{ index: number; error: string }> | undefined {
  return result.failures?.map(({ index, error }) => ({ index, error }))
}

interface PresentationSnapshot {
  slides: OpenedPptx['deck']['slides']
  entries: Map<string, unknown>
  size: OpenedPptx['deck']['size']
}

function captureSnapshot(opened: OpenedPptx): PresentationSnapshot {
  return {
    slides: structuredClone(opened.deck.slides),
    entries: new Map(opened.archive.entries as Map<string, unknown>),
    size: { ...opened.deck.size },
  }
}

function restore(opened: OpenedPptx, value: PresentationSnapshot): void {
  opened.deck.slides = value.slides
  opened.deck.size = value.size
  const entries = opened.archive.entries as Map<string, unknown>
  entries.clear()
  for (const [path, bytes] of value.entries) entries.set(path, bytes)
}

/**
 * Electron-free presentation state used by the browser Host and by Electron IPC.
 * It owns only PPTX data and transaction state; transports own paths, dialogs, and UI events.
 */
export class SlidesDocumentService {
  private constructor(
    private opened: OpenedPptx,
    private readonly title: string,
    private fitWidthPx: number,
    private contentVersion = 1,
  ) {}
  private readonly undoSnapshots: PresentationSnapshot[] = []
  private readonly redoSnapshots: PresentationSnapshot[] = []
  private elementClipboard: ElementClipboardItem[] = []

  static async open(bytes: Uint8Array, title: string, fitWidthPx: number): Promise<SlidesDocumentService> {
    return new SlidesDocumentService(await openPptx(bytes), title, fitWidthPx)
  }

  openResult(): OpenResult {
    return {
      path: `nexusdesk://${this.title}`,
      slides: render(this.opened, this.fitWidthPx),
      size: { ...this.opened.deck.size },
    }
  }

  setFitWidth(fitWidthPx: number): OpenResult {
    this.fitWidthPx = fitWidthPx
    return this.openResult()
  }

  renderSlides(): RenderSlide[] {
    return render(this.opened, this.fitWidthPx)
  }

  editText(request: EditTextOp): RenderSlide | null {
    const result = this.applyTransaction({
      ops: [
        {
          op: 'setText',
          target: { slide: request.slideIndex, el: request.sourceId },
          paragraphs: request.paragraphs,
          ...(request.groupId === undefined ? {} : { group: request.groupId }),
        },
      ],
    })
    if (!result.applied) return null
    return this.renderSlides()[request.slideIndex] ?? null
  }

  readPresentation(): { size: { cx: number; cy: number }; slides: RenderSlide[]; contentVersion: number } {
    return { size: { ...this.opened.deck.size }, slides: this.renderSlides(), contentVersion: this.contentVersion }
  }

  contentState(): { contentVersion: number } {
    return { contentVersion: this.contentVersion }
  }

  applyTransaction(request: ApplyTxnOp): ApplyTxnResult {
    const ops = Array.isArray(request.ops) ? (request.ops as Op[]) : []
    if (ops.length === 0 || ops.length > 50) {
      return { applied: false, failures: [{ index: 0, error: 'ops must be a non-empty array (at most 50 per transaction).' }] }
    }
    const isolation = request.isolation === 'per_op' ? 'per_op' : 'atomic'
    const transaction: TxnRequest = { ops, isolation, ...(request.dryRun ? { dryRun: true } : {}) }
    const before = request.dryRun ? undefined : captureSnapshot(this.opened)
    const result = runTxn(this.opened, transaction)
    if (request.dryRun) {
      return { applied: false, dryRun: true, plan: result.plan ?? [], ...(compact(result) === undefined ? {} : { failures: compact(result) }) }
    }
    if (!result.applied) return { applied: false, ...(compact(result) === undefined ? {} : { failures: compact(result) }) }
    this.undoSnapshots.push(before!)
    this.redoSnapshots.length = 0
    this.contentVersion += 1
    return {
      applied: true,
      contentVersion: this.contentVersion,
      records: (result.records ?? []).map((record) => ({
        op: record.op.op,
        ...(record.op.target === undefined ? {} : { target: `${String(record.op.target.slide)}${record.op.target.el === undefined ? '' : `/${record.op.target.el}`}` }),
        ...(record.created === undefined ? {} : { created: record.created }),
      })),
      ...(compact(result) === undefined ? {} : { failures: compact(result) }),
      slides: this.renderSlides(),
    }
  }

  async serializeBytes(): Promise<Uint8Array> {
    return savePptx(this.opened)
  }

  markSaved(): void {
    commitSaved(this.opened)
  }

  async saveBytes(): Promise<Uint8Array> {
    const bytes = await this.serializeBytes()
    this.markSaved()
    return bytes
  }

  isDirty(): boolean {
    return this.opened.deck.slides.some(
      (slide) => slide.structureDirty || slide.elements.some((element) => element.dirty || element.dirtyTransform),
    )
  }

  /**
   * Browser UI adapter for the foundational edit surface. Inputs retain the renderer's
   * pixel-facing IPC shape; this boundary converts them into the shared transaction DSL.
   */
  async executeUi(action: string, payload: unknown): Promise<unknown> {
    const input = record(payload)
    if (action === 'copy-elements') {
      const slide = this.opened.deck.slides[integer(input.slideIndex, 'slideIndex')]
      const sourceIds = Array.isArray(input.sourceIds) ? input.sourceIds : []
      if (slide === undefined) return 0
      this.elementClipboard = sourceIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => slide.elements.find((element) => element.id === id))
        .filter((element): element is NonNullable<typeof element> => element !== undefined)
        .map((element) => copyElementData(this.opened, slide, element))
      return this.elementClipboard.length
    }
    if (action === 'paste-elements' || action === 'duplicate-elements') {
      const slideIndex = integer(input.slideIndex, 'slideIndex')
      const slide = this.opened.deck.slides[slideIndex]
      if (slide === undefined) return null
      const items = action === 'paste-elements'
        ? this.elementClipboard
        : (Array.isArray(input.sourceIds) ? input.sourceIds : [])
          .filter((id): id is string => typeof id === 'string')
          .map((id) => slide.elements.find((element) => element.id === id))
          .filter((element): element is NonNullable<typeof element> => element !== undefined)
          .map((element) => copyElementData(this.opened, slide, element))
      if (items.length === 0) return null
      const toEmu = (px: unknown, name: string) => this.toEmu(px, input.fitWidthPx, name)
      const result = this.applyTransaction({
        ops: [{
          op: 'pasteElements', target: { slide: slideIndex }, items,
          dx: action === 'duplicate-elements' ? toEmu(input.dxPx, 'dxPx') : 0,
          dy: action === 'duplicate-elements' ? toEmu(input.dyPx, 'dyPx') : 0,
        } as Op],
      })
      if (!result.applied) return null
      return { slide: this.renderSlides()[slideIndex], sourceIds: result.records?.[0]?.created ?? [], contentVersion: result.contentVersion }
    }
    const operation = this.uiOperation(action, input)
    const result = this.applyTransaction({ ops: [operation] })
    if (!result.applied) return null
    const contentVersion = result.contentVersion!
    const slideIndex = typeof input.slideIndex === 'number' ? input.slideIndex : 0
    if (action === 'add-element' || action === 'add-table' || action === 'add-chart' || action === 'add-image-bytes') {
      const sourceId = result.records?.[0]?.created?.[0]
      const slide = this.renderSlides()[slideIndex]
      return sourceId === undefined || slide === undefined ? null : { slide, sourceId, contentVersion }
    }
    if (action === 'add-slide') return { slides: this.renderSlides(), index: integer(input.sourceIndex, 'sourceIndex') + 1, contentVersion }
    if (action === 'delete-slide' || action === 'move-slide') return { slides: this.renderSlides(), contentVersion }
    const slide = this.renderSlides()[slideIndex]
    return slide === undefined ? null : { slide, contentVersion }
  }

  async undo(): Promise<{ slides: RenderSlide[]; contentVersion: number } | null> {
    const previous = this.undoSnapshots.pop()
    if (previous === undefined) return null
    this.redoSnapshots.push(captureSnapshot(this.opened))
    restore(this.opened, previous)
    this.contentVersion += 1
    return { slides: this.renderSlides(), contentVersion: this.contentVersion }
  }

  async redo(): Promise<{ slides: RenderSlide[]; contentVersion: number } | null> {
    const next = this.redoSnapshots.pop()
    if (next === undefined) return null
    this.undoSnapshots.push(captureSnapshot(this.opened))
    restore(this.opened, next)
    this.contentVersion += 1
    return { slides: this.renderSlides(), contentVersion: this.contentVersion }
  }

  private uiOperation(action: string, input: Record<string, unknown>): Op {
    const slideIndex = () => integer(input.slideIndex, 'slideIndex')
    const target = (sourceId: unknown) => ({ slide: slideIndex(), el: typeof sourceId === 'string' ? sourceId : (() => { throw new Error('sourceId must be a string.') })() })
    const toEmu = (px: unknown, name: string) => this.toEmu(px, input.fitWidthPx, name)
    if (action === 'add-element') {
      if (typeof input.kind !== 'string') throw new Error('kind must be a string.')
      const paragraphs = Array.isArray(input.paragraphs)
        ? input.paragraphs
        : typeof input.text === 'string'
          ? input.text.split('\n').map((text) => ({ runs: [{ text }] }))
          : undefined
      return {
        op: 'addElement', target: { slide: slideIndex() }, kind: input.kind,
        offset: { x: toEmu(input.xPx, 'xPx'), y: toEmu(input.yPx, 'yPx'), cx: toEmu(input.wPx, 'wPx'), cy: toEmu(input.hPx, 'hPx') },
        ...(paragraphs === undefined ? {} : { paragraphs }),
        ...(typeof input.fillColor === 'string' ? { fill: input.fillColor } : {}),
      } as Op
    }
    if (action === 'add-table') return {
      op: 'addTable', target: { slide: slideIndex() }, rows: integer(input.rows, 'rows'), cols: integer(input.cols, 'cols'),
      offset: { x: toEmu(input.xPx, 'xPx'), y: toEmu(input.yPx, 'yPx'), cx: toEmu(input.wPx, 'wPx'), cy: toEmu(input.hPx, 'hPx') },
    } as Op
    if (action === 'add-chart') return {
      op: 'addChart', target: { slide: slideIndex() }, kind: input.kind,
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
      categories: input.categories, series: input.series,
      offset: { x: toEmu(input.xPx, 'xPx'), y: toEmu(input.yPx, 'yPx'), cx: toEmu(input.wPx, 'wPx'), cy: toEmu(input.hPx, 'hPx') },
    } as Op
    if (action === 'add-image-bytes') return {
      op: 'addPicture', target: { slide: slideIndex() },
      bytes: new Uint8Array(Buffer.from(String(input.base64 ?? ''), 'base64')),
      ext: String(input.ext ?? ''),
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
      offset: { x: toEmu(input.xPx, 'xPx'), y: toEmu(input.yPx, 'yPx'), cx: toEmu(input.wPx, 'wPx'), cy: toEmu(input.hPx, 'hPx') },
    } as Op
    if (action === 'delete-element') return { op: 'deleteElement', target: target(input.sourceId) } as Op
    if (action === 'edit-fill') return { op: 'setFill', target: target(input.sourceId), fill: input.fill, ...(typeof input.groupId === 'string' ? { group: input.groupId } : {}) } as Op
    if (action === 'edit-stroke') {
      const stroke = input.stroke
      if (stroke === null) return { op: 'setStroke', target: target(input.sourceId), stroke: null } as Op
      const value = record(stroke)
      return {
        op: 'setStroke', target: target(input.sourceId),
        stroke: { ...value, widthEmu: Math.round(finite(value.widthPt, 'stroke.widthPt') * EMU_PER_PT) },
        ...(typeof input.groupId === 'string' ? { group: input.groupId } : {}),
      } as Op
    }
    if (action === 'edit-transform') return {
      op: 'setTransform', target: target(input.sourceId),
      box: { x: toEmu(input.xPx, 'xPx'), y: toEmu(input.yPx, 'yPx'), cx: toEmu(input.wPx, 'wPx'), cy: toEmu(input.hPx, 'hPx') },
      rotDeg: finite(input.rotationDeg, 'rotationDeg'),
      ...(typeof input.groupId === 'string' ? { group: input.groupId } : { resizeTableGrid: true }),
    } as Op
    if (action === 'add-slide') return { op: 'duplicateSlide', target: { slide: integer(input.sourceIndex, 'sourceIndex') }, ...(input.clearText === true ? { clearText: true } : {}) } as Op
    if (action === 'delete-slide') return { op: 'deleteSlide', target: { slide: slideIndex() } } as Op
    if (action === 'move-slide') return { op: 'moveSlide', target: { slide: integer(input.fromIndex, 'fromIndex') }, to: integer(input.toIndex, 'toIndex') } as Op
    throw new Error(`Unsupported Slides browser UI operation: ${action}`)
  }

  private toEmu(px: unknown, fitWidthPx: unknown, name: string): number {
    const baseWidthPx = this.opened.deck.size.cx / EMU_PER_PX_96
    return Math.round((finite(px, name) / (finite(fitWidthPx, 'fitWidthPx') / baseWidthPx)) * EMU_PER_PX_96)
  }
}
