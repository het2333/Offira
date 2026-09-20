import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { HostError, shellDocumentSummarySchema } from '@nexusdesk/office-host'
import { PDFDocument } from 'pdf-lib'
import { assertPdfWebPayload, PdfPayloadTooLargeError } from '@nexusdesk/protocol'

import {
  applySaveRequest,
  insertBlankPageBytes,
  setPageSizeBytes,
  cropPagesBytes,
  readStaticFormFills,
} from '../../pdf/src/main/save-pdf'
import { listPageImages, renderImagePng } from '../../pdf/src/main/image-edit'
import {
  PDF_WEB_CAPABILITIES,
  parsePdfPageModification,
} from '../../pdf/src/shared/web-capabilities'
import type { SavePdfRequest } from '../../pdf/src/shared/ipc'
import {
  defaultWorkingCopyRoot,
  type WorkingCopyDriverOptions,
  type LocalDocumentDriver,
} from './document-driver'
import { createWorkingCopyStore } from './working-copy-store'
import { decodePdfWorkingCopy, pdfSaveHasEdits } from '../../pdf/src/shared/working-copy'

const PDF_CONTENT_TYPE = 'application/pdf'
const MAX_PDF_BYTES = 512 * 1024 * 1024

export type PdfSaveApplicator = (
  bytes: Uint8Array,
  request: SavePdfRequest,
) => Promise<{
  bytes: Uint8Array
  skippedTextEdits: unknown[]
  skippedTextInserts: unknown[]
  skippedImageEdits: unknown[]
}>

async function validatePdf(bytes: Uint8Array): Promise<void> {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_BYTES) throw new Error('unsafe size')
    await PDFDocument.load(bytes, { updateMetadata: false })
  } catch {
    throw new HostError(
      'INVALID_DOCUMENT_CONTENT',
      'The supplied content is not a supported PDF document.',
      false,
    )
  }
}

function assertInlineSave(value: unknown): void {
  try {
    assertPdfWebPayload(value)
  } catch (error) {
    if (error instanceof PdfPayloadTooLargeError)
      throw new HostError(error.code, error.message, false)
    throw error
  }
}

function saveRequest(value: unknown): SavePdfRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostError('INVALID_REQUEST', 'The PDF save request is invalid.', false)
  }
  const request = value as Partial<SavePdfRequest>
  if (
    !Array.isArray(request.markups) ||
    !Array.isArray(request.drawings) ||
    !Array.isArray(request.formValues) ||
    !Array.isArray(request.stamps)
  ) {
    throw new HostError('INVALID_REQUEST', 'The PDF save request is invalid.', false)
  }
  if (request.targetPath !== undefined || (request.redactions?.length ?? 0) > 0) {
    throw new HostError(
      'UNSUPPORTED_CAPABILITY',
      'Web PDF can save only the authorized document in place; Save As and permanent redaction are unavailable.',
      false,
    )
  }
  return request as SavePdfRequest
}

function assertCompleteSave(result: Awaited<ReturnType<PdfSaveApplicator>>): void {
  const skipped = [
    ...result.skippedTextEdits,
    ...result.skippedTextInserts,
    ...result.skippedImageEdits,
  ]
  if (skipped.length === 0) return
  const first = skipped[0] as { pageIndex?: unknown; reason?: unknown }
  const page = typeof first.pageIndex === 'number' ? ` on page ${String(first.pageIndex + 1)}` : ''
  const reason = typeof first.reason === 'string' ? `: ${first.reason}` : ''
  throw new HostError(
    'PDF_SAVE_INCOMPLETE',
    `The PDF save skipped ${String(skipped.length)} requested edit${skipped.length === 1 ? '' : 's'}${page}${reason}`,
    false,
  )
}

/** Create one authorized, revisioned driver for a renderer-owned PDF working copy. */
export async function createPdfDocumentDriver(
  path: string,
  options: WorkingCopyDriverOptions & { applySaveRequest?: PdfSaveApplicator } = {},
): Promise<LocalDocumentDriver> {
  const authorizedPath = resolve(path)
  await validatePdf(new Uint8Array(await readFile(authorizedPath)))
  const document = {
    documentId: `pdf-${createHash('sha256').update(authorizedPath).digest('hex').slice(0, 16)}`,
    title: basename(authorizedPath),
    editorType: 'pdf' as const,
    revision: 1,
    path: authorizedPath,
  }
  const store = await createWorkingCopyStore({
    rootDirectory: options.workingCopyRoot ?? defaultWorkingCopyRoot(),
    authorizedPath,
    documentId: document.documentId,
    editorType: 'pdf',
  })
  document.revision = (await store.getStatus()).workingRevision
  const sourceBytes = async (payload: unknown) => {
    const sourceContentId = (payload as { sourceContentId?: unknown } | null)?.sourceContentId
    if (sourceContentId !== undefined) {
      if (typeof sourceContentId !== 'string')
        throw new HostError('INVALID_REQUEST', 'Invalid PDF source', false)
      return store.readSource(sourceContentId)
    }
    return store.readWorkingBytes()
  }
  let writeQueue: Promise<void> = Promise.resolve()
  // Compatibility for trusted Host callers. HTTP mutations are rejected by the
  // server gate and must use the owner/approval coordinator. Even these direct
  // writes use Store promotion so they cannot invalidate its baseline.
  const persistTrustedSave = async (bytes: Uint8Array, expectedRevision: number) => {
    const status = await store.getStatus()
    if (status.workingRevision !== expectedRevision)
      throw new HostError('REVISION_CONFLICT', 'PDF working copy changed before saving.', false)
    const operationId = 'host-pdf-save-' + randomUUID()
    const digest = createHash('sha256').update(bytes).digest('hex')
    const result = { ok: true, summary: 'Saved PDF', warnings: [] }
    const prepared = await store.commitCheckpoint({
      documentEpoch: status.documentEpoch,
      expectedWorkingRevision: status.workingRevision,
      expectedSavedRevision: status.savedRevision,
      operationId: operationId + ':prepare',
      requestFingerprint: digest,
      planHash: digest,
      payloadHash: digest,
      payloadByteLength: bytes.byteLength,
      bytes,
      result,
    })
    await store.promoteWorkingCopy({
      documentEpoch: status.documentEpoch,
      expectedWorkingRevision: prepared.workingRevision,
      expectedSavedRevision: prepared.savedRevision,
      checkpointId: prepared.checkpointId,
      operationId,
      requestFingerprint: digest,
      planHash: digest,
      result,
    })
  }

  const write = <T>(expectedRevision: number, operation: () => Promise<T>): Promise<T> => {
    const result = writeQueue.then(async () => {
      if (expectedRevision !== document.revision) {
        throw new HostError(
          'REVISION_CONFLICT',
          'The document changed after this editor loaded it.',
          false,
        )
      }
      const value = await operation()
      document.revision = (await store.getStatus()).workingRevision
      return value
    })
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const driver: LocalDocumentDriver = {
    document,
    workingCopy: {
      store,
      acquireSource: () => store.acquireSource(),
      readSource: (id) => store.readSource(id),
      async materialize({ sourceContentId, payloadKind, parts }) {
        if (payloadKind !== 'pdf-save-plan')
          throw new HostError('INVALID_REQUEST', 'Expected a PDF save plan', false)
        const { request: decoded, modification } = decodePdfWorkingCopy(parts)
        const request = saveRequest(decoded)
        const source = await store.readSource(sourceContentId)
        let bytes = source
        if (pdfSaveHasEdits(request)) {
          const result = await (options.applySaveRequest ?? applySaveRequest)(source, request)
          assertCompleteSave(result)
          bytes = result.bytes
        }
        if (modification) {
          const parsed = await PDFDocument.load(bytes, { updateMetadata: false })
          const op = parsePdfPageModification(modification, parsed.getPageCount())
          bytes =
            op.action === 'insertBlankPage'
              ? await insertBlankPageBytes(bytes, op.afterPageIndex)
              : op.action === 'setPageSize'
                ? await setPageSizeBytes(bytes, op.width, op.height)
                : await cropPagesBytes(bytes, op.pages, op.rect)
        }
        await validatePdf(bytes)
        return bytes
      },
    },
    async bootstrap(origin) {
      return {
        documentId: document.documentId,
        title: document.title,
        revision: document.revision,
        websocketUrl: `${origin.replace(/^http/, 'ws')}/ws`,
        language: 'en',
        theme: 'system',
        contentUrl: `/api/documents/${encodeURIComponent(document.documentId)}/content`,
        capabilities: PDF_WEB_CAPABILITIES,
      }
    },
    async execute(action, payload) {
      if (action === 'list-static-form-fills')
        return { fills: await readStaticFormFills(await sourceBytes(payload)) }
      if (action === 'list-page-images') {
        return { images: await listPageImages(await sourceBytes(payload)) }
      }
      if (action === 'page-image-png') {
        const p = payload as {
          pageIndex?: unknown
          rect?: unknown
          scale?: unknown
          path?: unknown
        } | null
        if (
          !p ||
          p.path !== undefined ||
          !Number.isInteger(p.pageIndex) ||
          Number(p.pageIndex) < 0 ||
          !Array.isArray(p.rect) ||
          p.rect.length !== 4 ||
          !p.rect.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
          p.rect[0] >= p.rect[2] ||
          p.rect[1] >= p.rect[3] ||
          (p.scale !== undefined &&
            (typeof p.scale !== 'number' ||
              !Number.isFinite(p.scale) ||
              p.scale < 1 ||
              p.scale > 3))
        ) {
          throw new HostError('INVALID_REQUEST', 'Invalid PDF image preview request.', false)
        }
        return {
          png: await renderImagePng(
            await sourceBytes(payload),
            Number(p.pageIndex),
            p.rect as [number, number, number, number],
            Number(p.scale ?? 1),
          ),
        }
      }
      if (action === 'modify-pages') {
        const body = payload as {
          expectedRevision?: unknown
          modification?: unknown
          path?: unknown
        } | null
        if (!body || body.path !== undefined || !Number.isSafeInteger(body.expectedRevision))
          throw new HostError('INVALID_REQUEST', 'Invalid PDF page rewrite request.', false)
        await write(Number(body.expectedRevision), async () => {
          const bytes = new Uint8Array(await readFile(authorizedPath))
          const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
          let op
          try {
            op = parsePdfPageModification(body.modification, pdf.getPageCount())
          } catch (error) {
            throw new HostError('INVALID_REQUEST', String(error), false)
          }
          const result =
            op.action === 'insertBlankPage'
              ? await insertBlankPageBytes(bytes, op.afterPageIndex)
              : op.action === 'setPageSize'
                ? await setPageSizeBytes(bytes, op.width, op.height)
                : await cropPagesBytes(bytes, op.pages, op.rect)
          await validatePdf(result)
          await persistTrustedSave(result, Number(body.expectedRevision))
        })
        return { document: shellDocumentSummarySchema.parse(document) }
      }
      if (action !== 'save') {
        throw new HostError(
          'UNSUPPORTED_CAPABILITY',
          `Unsupported PDF document action: ${action}`,
          false,
        )
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new HostError('INVALID_REQUEST', 'The PDF save request is invalid.', false)
      }
      const body = payload as { expectedRevision?: unknown; request?: unknown }
      assertInlineSave(body)
      if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
        throw new HostError('INVALID_REQUEST', 'The PDF save revision is invalid.', false)
      }
      const request = saveRequest(body.request)
      const result = await write(body.expectedRevision as number, async () => {
        const applied = await (options.applySaveRequest ?? applySaveRequest)(
          new Uint8Array(await readFile(authorizedPath)),
          request,
        )
        assertCompleteSave(applied)
        await persistTrustedSave(applied.bytes, body.expectedRevision as number)
        return applied
      })
      return {
        document: shellDocumentSummarySchema.parse(document),
        skippedTextEdits: result.skippedTextEdits,
        skippedTextInserts: result.skippedTextInserts,
        skippedImageEdits: result.skippedImageEdits,
      }
    },
    async readContent() {
      return {
        bytes: await store.readWorkingBytes(),
        contentType: PDF_CONTENT_TYPE,
      }
    },
    writeContent(bytes, expectedRevision) {
      return write(expectedRevision, async () => {
        await validatePdf(bytes)
        await persistTrustedSave(bytes, expectedRevision)
      }).then(() => shellDocumentSummarySchema.parse(document))
    },
    async close() {},
  }
  return driver
}
