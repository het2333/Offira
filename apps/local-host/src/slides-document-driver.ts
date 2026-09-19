import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import JSZip from 'jszip'
import { HostError, shellDocumentSummarySchema } from '@nexusdesk/office-host'
import type { DocumentId } from '@nexusdesk/protocol'

import type { LocalDocumentDriver } from './document-driver'

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

  return {
    document,
    async bootstrap(origin) {
      return {
        documentId: id,
        title,
        revision,
        websocketUrl: origin.replace(/^http/, 'ws') + '/ws',
        language: 'en',
        theme: 'system',
        contentUrl: `/api/documents/${id}/content`,
      }
    },
    async execute(action) {
      throw new HostError('UNSUPPORTED_CAPABILITY', `Slides action ${action} requires an active browser editor.`, false, id)
    },
    async readContent() {
      return { bytes: new Uint8Array(await readFile(resolvedPath)), contentType: PPTX_CONTENT_TYPE }
    },
    async writeContent(bytes, expectedRevision) {
      const run = async () => {
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
      const result = queue.then(run, run)
      queue = result.then(() => undefined, () => undefined)
      return result
    },
    async close() {
      await queue
      await stat(resolvedPath)
    },
  }
}
