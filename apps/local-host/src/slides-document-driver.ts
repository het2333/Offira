import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import JSZip from 'jszip'
import { HostError, shellDocumentSummarySchema } from '@nexusdesk/office-host'
import type { DocumentId } from '@nexusdesk/protocol'

import type { LocalDocumentDriver } from './document-driver'
import { SlidesWebServiceClient } from './slides-web-service-client'

const PPTX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const MAX_PRESENTATION_BYTES = 512 * 1024 * 1024

function documentId(path: string): string {
  return `slides-${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 24)}`
}

async function validPresentation(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PRESENTATION_BYTES) {
    throw new HostError('INVALID_DOCUMENT_CONTENT', 'Presentation content is empty or exceeds the safe size limit.', false)
  }
  try {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
    if (zip.file('ppt/presentation.xml') === null || zip.file('[Content_Types].xml') === null) {
      throw new Error('required PowerPoint parts are missing')
    }
  } catch {
    throw new HostError('INVALID_DOCUMENT_CONTENT', 'The replacement is not a valid PPTX presentation.', false)
  }
}

/** Owns exactly one already-authorized PowerPoint file for the Local Web Host. */
export async function createSlidesDocumentDriver(path: string): Promise<LocalDocumentDriver> {
  const resolvedPath = resolve(path)
  const source = await readFile(resolvedPath)
  await validPresentation(source)
  const service = await SlidesWebServiceClient.open(new Uint8Array(source), basename(resolvedPath))
  let revision = 1
  let queue = Promise.resolve()
  const id = documentId(resolvedPath) as DocumentId
  const title = basename(resolvedPath)
  const document = {
    documentId: id,
    title,
    editorType: 'slides' as const,
    get revision() {
      return revision
    },
    path: resolvedPath,
  }

  const runQueued = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  const replaceOnDisk = async (bytes: Uint8Array, expectedRevision: number) => {
    if (expectedRevision !== revision) {
      throw new HostError('REVISION_CONFLICT', 'The presentation changed before this save completed.', false, id)
    }
    await validPresentation(bytes)
    const temporaryPath = join(dirname(resolvedPath), `.${title}.${randomBytes(12).toString('hex')}.tmp`)
    try {
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, resolvedPath)
      revision += 1
      return shellDocumentSummarySchema.parse({ documentId: id, title, editorType: 'slides', revision })
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  const expectedSaveRevision = (payload: unknown): number => {
    const value = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as { expectedRevision?: unknown }).expectedRevision
      : undefined
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new HostError('INVALID_REQUEST', 'Slides save requires a positive expectedRevision.', false, id)
    }
    return value
  }

  const saveSession = (expectedRevision: number) => runQueued(async () => {
    if (expectedRevision !== revision) {
      throw new HostError('REVISION_CONFLICT', 'The presentation changed before this save completed.', false, id)
    }
    const serialized = await service.request('serialize', {}) as {
      bytes: Uint8Array
      slides: unknown
    }
    if (!(serialized.bytes instanceof Uint8Array)) {
      throw new HostError('INVALID_DOCUMENT_CONTENT', 'Slides service returned invalid presentation bytes.', false, id)
    }
    const summary = await replaceOnDisk(serialized.bytes, expectedRevision)
    await service.request('commit-saved', {})
    return { ok: true, path: resolvedPath, revision: summary.revision, slides: serialized.slides }
  })

  return {
    document,
    async bootstrap(origin) {
      const contentState = await service.request('content-state', {}) as { contentVersion?: unknown }
      if (typeof contentState.contentVersion !== 'number' || !Number.isSafeInteger(contentState.contentVersion)) {
        throw new HostError('INVALID_DOCUMENT_CONTENT', 'Slides service returned an invalid content version.', false, id)
      }
      return {
        documentId: id,
        title,
        revision,
        contentVersion: contentState.contentVersion,
        websocketUrl: origin.replace(/^http/, 'ws') + '/ws',
        language: 'en',
        theme: 'system',
        contentUrl: `/api/documents/${id}/content`,
      }
    },
    async execute(action, payload) {
      if (action === 'slides:save') return saveSession(expectedSaveRevision(payload))
      if (
        action === 'slides:open' ||
        action === 'slides:edit-text' ||
        action === 'slides:apply-txn' ||
        action === 'slides:read-presentation' ||
        action === 'slides:content-state' ||
        action === 'slides:render-slides' ||
        action === 'slides:is-dirty' ||
        action === 'slides:undo' ||
        action === 'slides:redo'
      ) {
        return runQueued(() => service.request(action.slice('slides:'.length), payload))
      }
      if (action === 'slides:ui') return runQueued(() => service.request('ui', payload))
      throw new HostError('UNSUPPORTED_CAPABILITY', `Slides action ${action} is unavailable in Local Web.`, false, id)
    },
    async readContent() {
      return { bytes: new Uint8Array(await readFile(resolvedPath)), contentType: PPTX_CONTENT_TYPE }
    },
    async writeContent(bytes, expectedRevision) {
      return runQueued(async () => {
        const summary = await replaceOnDisk(bytes, expectedRevision)
        await service.request('replace', { bytes, title, fitWidthPx: 960 })
        return summary
      })
    },
    async close() {
      await queue
      await service.close()
      await stat(resolvedPath)
    },
  }
}
