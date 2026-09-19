import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { HostError, shellDocumentSummarySchema } from '@nexusdesk/office-host'
import { PDFDocument } from 'pdf-lib'

import { applySaveRequest } from '../../pdf/src/main/save-pdf'
import { listPageImages } from '../../pdf/src/main/image-edit'
import type { PageImageRef, SavePdfRequest } from '../../pdf/src/shared/ipc'
import type { LocalDocumentDriver } from './document-driver'

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

async function fsyncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined
  try {
    directory = await open(path, 'r')
    await directory.sync()
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error
  } finally {
    await directory?.close().catch(() => undefined)
  }
}

async function atomicReplace(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, path)
    await fsyncDirectory(dirname(path))
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
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
  options: { applySaveRequest?: PdfSaveApplicator } = {},
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
  let writeQueue: Promise<void> = Promise.resolve()

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
      await stat(authorizedPath)
      document.revision += 1
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
    async bootstrap(origin) {
      return {
        documentId: document.documentId,
        title: document.title,
        revision: document.revision,
        websocketUrl: `${origin.replace(/^http/, 'ws')}/ws`,
        language: 'en',
        theme: 'system',
        contentUrl: `/api/documents/${encodeURIComponent(document.documentId)}/content`,
        capabilities: {
          saveInPlace: true,
          textReflow: false,
          nativeFileDialogs: false,
          permanentRedaction: false,
        },
      }
    },
    async execute(action, payload) {
      if (action === 'list-page-images') {
        return { images: await listPageImages(new Uint8Array(await readFile(authorizedPath))) }
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
        await atomicReplace(authorizedPath, applied.bytes)
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
        bytes: new Uint8Array(await readFile(authorizedPath)),
        contentType: PDF_CONTENT_TYPE,
      }
    },
    writeContent(bytes, expectedRevision) {
      return write(expectedRevision, async () => {
        await validatePdf(bytes)
        await atomicReplace(authorizedPath, bytes)
      }).then(() => shellDocumentSummarySchema.parse(document))
    },
    async close() {},
  }
  return driver
}
