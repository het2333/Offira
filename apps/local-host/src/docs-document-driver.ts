import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'
import JSZip, { type JSZipObject } from 'jszip'
import { HostError, shellDocumentSummarySchema } from '@nexusdesk/office-host'

import type { LocalDocumentDriver } from './document-driver'

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MAIN_DOCUMENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const OFFICE_DOCUMENT_RELATIONSHIP = '/officeDocument'
const MAX_ZIP_ENTRIES = 10_000
const MAX_UNCOMPRESSED_BYTES = 536_870_912
const MAX_REQUIRED_XML_BYTES = 16_777_216

interface ZipEntryWithSize extends JSZipObject {
  _data?: { uncompressedSize?: number }
}

function values<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

async function requiredXml(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path)
  if (entry === null) throw new Error(`DOCX is missing ${path}.`)
  const size = (entry as ZipEntryWithSize)._data?.uncompressedSize
  if (size === undefined || size > MAX_REQUIRED_XML_BYTES) {
    throw new Error(`DOCX part ${path} exceeds its safe size limit.`)
  }
  return entry.async('string')
}

async function validateDocx(bytes: Uint8Array): Promise<void> {
  try {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
    const entries = Object.values(zip.files)
    if (entries.length === 0 || entries.length > MAX_ZIP_ENTRIES) {
      throw new Error('DOCX contains an unsafe number of ZIP entries.')
    }
    let uncompressedBytes = 0
    for (const entry of entries) {
      const size = (entry as ZipEntryWithSize)._data?.uncompressedSize
      if (!entry.dir && size === undefined) throw new Error('DOCX ZIP entry size is unavailable.')
      uncompressedBytes += size ?? 0
      if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('DOCX expands beyond its safe size limit.')
      }
    }

    const parser = new XMLParser({ ignoreAttributes: false })
    const relationships = parser.parse(await requiredXml(zip, '_rels/.rels')) as {
      Relationships?: {
        Relationship?: Array<Record<string, unknown>> | Record<string, unknown>
      }
    }
    const officeDocument = values(relationships.Relationships?.Relationship).find((relationship) =>
      String(relationship['@_Type'] ?? '').endsWith(OFFICE_DOCUMENT_RELATIONSHIP),
    )
    const target = String(officeDocument?.['@_Target'] ?? '').replace(/^\/+/, '')
    if (target.length === 0 || target.split('/').includes('..') || zip.file(target) === null) {
      throw new Error('DOCX has no safe main document relationship.')
    }

    const contentTypes = parser.parse(await requiredXml(zip, '[Content_Types].xml')) as {
      Types?: { Override?: Array<Record<string, unknown>> | Record<string, unknown> }
    }
    const mainPart = `/${target}`
    const hasMainContentType = values(contentTypes.Types?.Override).some(
      (override) =>
        override['@_PartName'] === mainPart && override['@_ContentType'] === MAIN_DOCUMENT_TYPE,
    )
    if (!hasMainContentType) throw new Error('DOCX main document content type is invalid.')

    const mainDocument = parser.parse(await requiredXml(zip, target)) as Record<string, unknown>
    if (!Object.keys(mainDocument).some((key) => key.endsWith(':document') || key === 'document')) {
      throw new Error('DOCX main document XML is invalid.')
    }
  } catch {
    throw new HostError(
      'INVALID_DOCUMENT_CONTENT',
      'The supplied content is not a supported DOCX document.',
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

/** Create one authorized, revisioned driver for a renderer-owned DOCX working copy. */
export async function createDocsDocumentDriver(path: string): Promise<LocalDocumentDriver> {
  const authorizedPath = resolve(path)
  const initialBytes = new Uint8Array(await readFile(authorizedPath))
  await validateDocx(initialBytes)
  const document = {
    documentId: `docx-${createHash('sha256').update(authorizedPath).digest('hex').slice(0, 16)}`,
    title: basename(authorizedPath),
    editorType: 'docs' as const,
    revision: 1,
    path: authorizedPath,
  }
  let writeQueue: Promise<void> = Promise.resolve()

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
      }
    },
    async execute(action) {
      throw new HostError(
        'UNSUPPORTED_CAPABILITY',
        `Unsupported Docs document action: ${action}`,
        false,
      )
    },
    async readContent() {
      return {
        bytes: new Uint8Array(await readFile(authorizedPath)),
        contentType: DOCX_CONTENT_TYPE,
      }
    },
    writeContent(bytes, expectedRevision) {
      const write = writeQueue.then(async () => {
        if (expectedRevision !== document.revision) {
          throw new HostError(
            'REVISION_CONFLICT',
            'The document changed after this editor loaded it.',
            false,
          )
        }
        await validateDocx(bytes)
        await atomicReplace(authorizedPath, bytes)
        await stat(authorizedPath)
        document.revision += 1
        return shellDocumentSummarySchema.parse(document)
      })
      writeQueue = write.then(
        () => undefined,
        () => undefined,
      )
      return write
    },
    async close() {},
  }
  return driver
}
