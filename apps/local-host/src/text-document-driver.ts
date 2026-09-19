import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { HostError, type EditorKind, shellDocumentSummarySchema } from '@nexusdesk/office-host'

import type { LocalDocumentDriver } from './document-driver'

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
  validateUtf8(new Uint8Array(await readFile(authorizedPath)))
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
      return { bytes: new Uint8Array(await readFile(authorizedPath)), contentType: TEXT_CONTENT_TYPES[editorType] }
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
        await atomicReplace(authorizedPath, bytes)
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
}
