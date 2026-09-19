import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { HostError, type EditorKind, shellDocumentSummarySchema } from '@nexusdesk/office-host'

import type { LocalDocumentDriver } from './document-driver'

interface TextRecoveryRecord {
  version: 2
  editorType: Extract<EditorKind, 'markdown' | 'html'>
  baseline: PersistentBaselineIdentity
  content: string
}

interface PersistentBaselineIdentity {
  sha256: string
  device: string
  inode: string
  size: string
  mtimeNs: string
  ctimeNs: string
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

function sameBaseline(left: PersistentBaselineIdentity, right: PersistentBaselineIdentity): boolean {
  return left.sha256 === right.sha256 &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
}

function isBaseline(value: unknown): value is PersistentBaselineIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return ['sha256', 'device', 'inode', 'size', 'mtimeNs', 'ctimeNs'].every(
    (key) => typeof record[key] === 'string',
  )
}

async function readBaseline(path: string): Promise<{
  bytes: Uint8Array
  identity: PersistentBaselineIdentity
}> {
  const handle = await open(path, 'r')
  try {
    const bytes = new Uint8Array(await handle.readFile())
    validateUtf8(bytes)
    const stat = await handle.stat({ bigint: true })
    return {
      bytes,
      identity: {
        sha256: contentHash(bytes),
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
      },
    }
  } finally {
    await handle.close()
  }
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
  const initial = await readBaseline(authorizedPath)
  let baseline = initial.identity
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
        parsed.version !== 2 ||
        parsed.editorType !== editorType ||
        !isBaseline(parsed.baseline) ||
        !sameBaseline(parsed.baseline, baseline) ||
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
    const disk = await readBaseline(authorizedPath)
    if (sameBaseline(disk.identity, baseline)) return
    await clearRecovery()
    baseline = disk.identity
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
      const disk = await readBaseline(authorizedPath)
      if (!sameBaseline(disk.identity, baseline)) {
        await clearRecovery()
        baseline = disk.identity
        document.revision += 1
      }
      return { bytes: recovery ?? disk.bytes, contentType: TEXT_CONTENT_TYPES[editorType] }
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
        baseline = (await readBaseline(authorizedPath)).identity
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
          version: 2,
          editorType,
          baseline,
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
