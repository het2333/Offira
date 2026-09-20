import type { BrowserWorkingCopyPayload } from '@nexusdesk/web-client'
import type { SavePdfRequest, StampInput, StaticFormFillRecord } from '../../shared/ipc'
import type { EditSnapshot, SavedSnapshot, StampConfig } from '../edit-state'
import type { PdfPageModification } from '../../shared/web-capabilities'
import { encodePdfWorkingCopy } from '../../shared/working-copy'

export function capturePdfWorkingCopy(
  request: SavePdfRequest,
  modification?: PdfPageModification,
): BrowserWorkingCopyPayload {
  return {
    kind: 'pdf-save-plan',
    parts: new Map(
      [...encodePdfWorkingCopy(request, modification)].map(([key, bytes]) => [
        key,
        new Blob([bytes as Uint8Array<ArrayBuffer>]),
      ]),
    ),
  }
}

/** Rebase subtracts only this captured set; later edits remain pending. */
export function pdfSavedSnapshot(
  state: EditSnapshot,
  pageCount: number,
  modification?: PdfPageModification,
): SavedSnapshot {
  const pages = (state.order ?? Array.from({ length: pageCount }, (_, i) => i)).filter(
    (i) => !state.deleted.has(i),
  )
  return {
    markupIds: new Set(state.markups.map((e) => e.id)),
    annotDeleteIds: new Set(state.annotDeletes.map((e) => e.id)),
    noteEditIds: new Set(state.noteEdits.map((e) => e.id)),
    noteEditWritten: new Map(state.noteEdits.map((e) => [e.annot.objNum, e.contents])),
    drawingIds: new Set(state.drawings.map((e) => e.id)),
    textEditIds: new Set(state.textEdits.map((e) => e.id)),
    textInsertIds: new Set(state.textInserts.map((e) => e.id)),
    imageEditIds: new Set(state.imageEdits.map((e) => e.id)),
    stampCfg: state.stampCfg,
    formEdits: state.formEdits,
    rotations: state.rotations,
    metadata: state.metadata,
    pageMap: new Map(
      pages.map((original, index) => [
        original,
        modification?.action === 'insertBlankPage' && index > modification.afterPageIndex
          ? index + 1
          : index,
      ]),
    ),
  }
}

/** Uses only the provided post-state; no React closure or asynchronously updated state. */
export function buildPdfSaveRequest(
  state: EditSnapshot,
  options: {
    path: string
    pageCount: number
    savedStaticFormFills: StaticFormFillRecord[]
    renderStamps(config: StampConfig, pages: number[]): StampInput[]
  },
): SavePdfRequest {
  const pages = (state.order ?? Array.from({ length: options.pageCount }, (_, i) => i)).filter(
    (i) => !state.deleted.has(i),
  )
  const staticFills = new Map(options.savedStaticFormFills.map((record) => [record.id, record]))
  for (const edit of state.imageEdits) {
    if (!edit.staticFill) continue
    if (edit.input.kind === 'deleteImage') staticFills.delete(edit.staticFill.id)
    else
      staticFills.set(edit.staticFill.id, {
        ...edit.staticFill,
        pageIndex: edit.input.pageIndex,
        rect: edit.input.rect,
      })
  }
  return {
    path: options.path,
    markups: state.markups.map(({ id: _id, ...rest }) => rest),
    annotDeletes: state.annotDeletes.map(({ annot }) => ({
      pageIndex: annot.pageIndex,
      objNum: annot.objNum,
      subtype: annot.type,
      rect: annot.rect,
      ...(annot.type === 'note' ? { contents: annot.contents } : {}),
    })),
    noteEdits: state.noteEdits.map(({ annot, contents }) => ({
      pageIndex: annot.pageIndex,
      objNum: annot.objNum,
      rect: annot.rect,
      oldContents: annot.contents,
      contents,
    })),
    drawings: state.drawings.map((d) => d.input),
    textEdits: state.textEdits.map((e) => e.input),
    textInserts: state.textInserts.map((e) => e.input),
    imageEdits: state.imageEdits.map((e) => e.input),
    ...(state.imageEdits.length || state.deleted.size || state.order
      ? { staticFormFills: [...staticFills.values()] }
      : {}),
    stamps: state.stampCfg ? options.renderStamps(state.stampCfg, pages) : [],
    formValues: [...state.formEdits.values()],
    rotations: [...state.rotations].map(([pageIndex, delta]) => ({ pageIndex, delta })),
    deletedPages: [...state.deleted],
    ...(state.order ? { pageOrder: pages } : {}),
    ...(state.metadata ? { metadata: state.metadata } : {}),
  }
}
