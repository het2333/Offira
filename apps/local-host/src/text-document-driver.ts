import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { HostError, type EditorKind, shellDocumentSummarySchema } from '@nexusdesk/office-host'

import type { LocalDocumentDriver } from './document-driver'

interface TextRecoveryRecord {
  version: 1
  editorType: Extract<EditorKind, 'markdown' | 'html'>
  baselineHash: string
  content: string
}

const TEXT_CONTENT_TYPES: Record<Extract<EditorKind, 'markdown' | 'html'>, string> = {
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
}

function documentPrefix(editorType: Extract<EditorKind, 'markdown' | 'html'>): string {
  return editorType === 'markdown' ? 'markdown' : 'html'
}

function validateUtf8(bytes: Uint8Array): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new HostError(
      'INVALID_DOCUMENT_CONTENT',
      'The supplied content is not valid UTF-8 text.',
      false,
    )
  }
}

function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function recoveryPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.nexusdesk-recovery.json`)
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
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

/** Creates one Host-authorized UTF-8 Markdown or HTML document driver. */
export async function createTextDocumentDriver(
  path: string,
  editorType: Extract<EditorKind, 'markdown' | 'html'>,
): Promise<LocalDocumentDriver> {
  const authorizedPath = resolve(path)
  const initialBytes = new Uint8Array(await readFile(authorizedPath))
  validateUtf8(initialBytes)
  let baselineHash = contentHash(initialBytes)
  const sidecarPath = recoveryPath(authorizedPath)
  const document = {
    documentId: `${documentPrefix(editorType)}-${createHash('sha256')
      .update(authorizedPath)
      .digest('hex')
      .slice(0, 16)}`,
    title: basename(authorizedPath),
    editorType,
    revision: 1,
    path: authorizedPath,
  }
  let writeQueue: Promise<void> = Promise.resolve()
  let preview: Uint8Array | undefined
  let recovery: Uint8Array | undefined

  const clearRecovery = async (): Promise<void> => {
    recovery = undefined
    await unlink(sidecarPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  const readValidRecovery = async (): Promise<Uint8Array | undefined> => {
    try {
      const raw = await readFile(sidecarPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<TextRecoveryRecord>
      if (
        parsed.version !== 1 ||
        parsed.editorType !== editorType ||
        parsed.baselineHash !== baselineHash ||
        typeof parsed.content !== 'string'
      ) {
        await clearRecovery()
        return undefined
      }
      const bytes = new TextEncoder().encode(parsed.content)
      validateUtf8(bytes)
      return bytes
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      await clearRecovery()
      return undefined
    }
  }
  recovery = await readValidRecovery()

  const assertBaseline = async (): Promise<void> => {
    const diskBytes = new Uint8Array(await readFile(authorizedPath))
    validateUtf8(diskBytes)
    const diskHash = contentHash(diskBytes)
    if (diskHash === baselineHash) return
    await clearRecovery()
    baselineHash = diskHash
    document.revision += 1
    throw new HostError(
      'REVISION_CONFLICT',
      'The document changed on disk after this editor loaded it.',
      false,
    )
  }

  return {
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
        recoveryUrl: `/api/documents/${encodeURIComponent(document.documentId)}/recovery`,
        ...(editorType === 'html'
          ? { previewUrl: `/api/documents/${encodeURIComponent(document.documentId)}/preview` }
          : {}),
      }
    },
    async execute(action) {
      throw new HostError(
        'UNSUPPORTED_CAPABILITY',
        `Unsupported ${editorType} document action: ${action}`,
        false,
      )
    },
    async readContent() {
      const diskBytes = new Uint8Array(await readFile(authorizedPath))
      validateUtf8(diskBytes)
      const diskHash = contentHash(diskBytes)
      if (diskHash !== baselineHash) {
        await clearRecovery()
        baselineHash = diskHash
        document.revision += 1
      }
      return { bytes: recovery ?? diskBytes, contentType: TEXT_CONTENT_TYPES[editorType] }
    },
    async readPreview() {
      if (editorType !== 'html') {
        throw new HostError('UNSUPPORTED_CAPABILITY', 'Markdown documents do not expose an HTML preview.', false)
      }
      return {
        bytes: preview ?? new Uint8Array(await readFile(authorizedPath)),
        contentType: TEXT_CONTENT_TYPES.html,
      }
    },
    async writePreview(bytes) {
      if (editorType !== 'html') {
        throw new HostError('UNSUPPORTED_CAPABILITY', 'Markdown documents do not accept an HTML preview.', false)
      }
      validateUtf8(bytes)
      preview = new Uint8Array(bytes)
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
        validateUtf8(bytes)
        await assertBaseline()
        await atomicReplace(authorizedPath, bytes)
        baselineHash = contentHash(bytes)
        await clearRecovery()
        document.revision += 1
        return shellDocumentSummarySchema.parse(document)
      })
      writeQueue = write.then(
        () => undefined,
        () => undefined,
      )
      return write
    },
    writeRecovery(bytes, expectedRevision) {
      const write = writeQueue.then(async () => {
        if (expectedRevision !== document.revision) {
          throw new HostError(
            'REVISION_CONFLICT',
            'The document changed after this editor loaded it.',
            false,
          )
        }
        validateUtf8(bytes)
        await assertBaseline()
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const record: TextRecoveryRecord = {
          version: 1,
          editorType,
          baselineHash,
          content,
        }
        await atomicReplace(sidecarPath, new TextEncoder().encode(JSON.stringify(record)))
        recovery = new Uint8Array(bytes)
      })
      writeQueue = write.then(
        () => undefined,
        () => undefined,
      )
      return write
    },
    async close() {},
  }
}
