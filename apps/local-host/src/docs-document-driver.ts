import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'
import JSZip, { type JSZipObject } from 'jszip'
import { HostError } from '@nexusdesk/office-host'

import {
  defaultWorkingCopyRoot,
  type LocalDocumentDriver,
  type WorkingCopyDriverOptions,
} from './document-driver'
import { createWorkingCopyStore } from './working-copy-store'

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

/** Create one authorized, revisioned driver for a renderer-owned DOCX working copy. */
export async function createDocsDocumentDriver(
  path: string,
  options: WorkingCopyDriverOptions = {},
): Promise<LocalDocumentDriver> {
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
  const store = await createWorkingCopyStore({
    rootDirectory: options.workingCopyRoot ?? defaultWorkingCopyRoot(),
    authorizedPath,
    documentId: document.documentId,
    editorType: 'docs',
  })
  document.revision = (await store.getStatus()).workingRevision

  const driver: LocalDocumentDriver = {
    document,
    workingCopy: {
      store,
      acquireSource: () => store.acquireSource(),
      readSource: (id) => store.readSource(id),
      async materialize({ sourceContentId, payloadKind, parts }) {
        await store.readSource(sourceContentId)
        const bytes = parts.get('document')
        if (payloadKind !== 'docx-bytes' || parts.size !== 1 || !bytes) {
          throw new HostError(
            'INVALID_DOCUMENT_CONTENT',
            'A DOCX checkpoint requires exactly one document part.',
            false,
          )
        }
        const copy = new Uint8Array(bytes)
        await validateDocx(copy)
        return copy
      },
    },
    async bootstrap(origin) {
      const status = await store.getStatus()
      if (status.recoveryState !== 'ready') {
        throw new HostError(
          'REVISION_CONFLICT',
          'The original file changed; DOCX recovery requires attention.',
          false,
        )
      }
      const source = await store.acquireSource()
      const contentUrl = `/api/documents/${encodeURIComponent(document.documentId)}/sources/${source.sourceContentId}/content`
      document.revision = status.workingRevision
      return {
        documentId: document.documentId,
        title: document.title,
        revision: document.revision,
        websocketUrl: `${origin.replace(/^http/, 'ws')}/ws`,
        language: 'en',
        theme: 'system',
        contentUrl,
        workingCopy: {
          documentEpoch: status.documentEpoch,
          workingRevision: status.workingRevision,
          savedRevision: status.savedRevision,
          sourceContentId: source.sourceContentId,
          checkpointId: status.head?.checkpointId ?? null,
          dirty: status.dirty,
          recoveryState: status.recoveryState,
          contentUrl,
        },
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
        bytes: await store.readWorkingBytes(),
        contentType: DOCX_CONTENT_TYPE,
      }
    },
    async writeContent() {
      throw new HostError(
        'UNSUPPORTED_CAPABILITY',
        'Save DOCX through the working-copy coordinator.',
        false,
      )
    },
    async close() {},
  }
  return driver
}
