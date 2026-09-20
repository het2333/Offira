import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, unlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkpointPartSchema, type CheckpointPart } from '@nexusdesk/protocol'

export class CheckpointUploadError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CheckpointUploadError' }
}
interface Upload<T> {
  metadata: T
  directory: string
  expiresAt: number
  parts: Map<string, CheckpointPart>
  byteLength: number
  sealed: boolean
}
export interface CheckpointUploadStoreOptions<T = unknown> {
  rootDirectory?: string
  maxByteLength?: number
  maxUploads?: number
  maxUploadsPerGroup?: number
  groupKey?: (metadata: T) => string
  maxParts?: number
  ttlMs?: number
  now?: () => number
}
/** Temporary files are scoped to this process's uploads, never renderer-controlled paths. */
export class CheckpointUploadStore<T = unknown> {
  private readonly uploads = new Map<string, Upload<T>>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly now: () => number
  constructor(private readonly options: CheckpointUploadStoreOptions<T> = {}) {
    this.now = options.now ?? Date.now
  }
  private lane<R>(id: string, task: () => Promise<R>): Promise<R> {
    const pending = (this.queues.get(id) ?? Promise.resolve()).then(task)
    const tail = pending.then(() => undefined, () => undefined)
    this.queues.set(id, tail)
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id) })
    return pending
  }
  async create(metadata: T): Promise<string> {
    return this.lane('create', async () => {
      for (const [id, upload] of this.uploads) {
        if (upload.expiresAt <= this.now() && !upload.sealed && !this.queues.has(id)) await this.discard(id)
      }
      if (this.uploads.size >= (this.options.maxUploads ?? 4)) throw new CheckpointUploadError('UPLOAD_LIMIT', 'Too many active checkpoint uploads.')
      if (this.options.groupKey) {
        const key = this.options.groupKey(metadata)
        const active = [...this.uploads.values()].filter((upload) => this.options.groupKey!(upload.metadata) === key).length
        if (active >= (this.options.maxUploadsPerGroup ?? 2)) throw new CheckpointUploadError('UPLOAD_LIMIT', 'Too many active uploads for this document.')
      }
      const root = this.options.rootDirectory ?? tmpdir()
      await mkdir(root, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(root, 'nexusdesk-upload-'))
      const id = randomUUID()
      this.uploads.set(id, { metadata, directory, expiresAt: this.now() + (this.options.ttlMs ?? 300_000),
        parts: new Map(), byteLength: 0, sealed: false })
      return id
    })
  }
  async get(id: string): Promise<T> {
    const upload = this.uploads.get(id)
    if (!upload || (upload.expiresAt <= this.now() && !upload.sealed)) {
      if (upload && !this.queues.has(id)) await this.discard(id)
      throw new CheckpointUploadError('UPLOAD_NOT_FOUND', 'The checkpoint upload expired or is unavailable.')
    }
    return upload.metadata
  }
  put(id: string, partId: string, stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<CheckpointPart> {
    return this.lane(id, async () => {
      await this.get(id)
      const upload = this.uploads.get(id)!
      if (!/^(document|manifest|edits-\d{4}|asset-\d{4})$/.test(partId) || upload.sealed) {
        throw new CheckpointUploadError('WORKING_COPY_INVALID_CHECKPOINT', 'Invalid part identifier or sealed upload.')
      }
      if (!upload.parts.has(partId) && upload.parts.size >= (this.options.maxParts ?? 4096)) {
        throw new CheckpointUploadError('UPLOAD_LIMIT', 'The upload contains too many parts.')
      }
      const path = join(upload.directory, partId + '-' + randomUUID())
      const handle = await open(path, 'wx', 0o600)
      const hash = createHash('sha256')
      let byteLength = 0
      try {
        for await (const chunk of stream) {
          byteLength += chunk.byteLength
          const total = upload.byteLength - (upload.parts.get(partId)?.byteLength ?? 0) + byteLength
          if (total > Math.min(this.options.maxByteLength ?? 134_217_728, 134_217_728)) {
            throw new CheckpointUploadError('CONTENT_TOO_LARGE', 'The upload exceeds its total byte limit.')
          }
          if ((partId === 'manifest' || partId.startsWith('edits-')) && byteLength > 262_144) {
            throw new CheckpointUploadError('CONTENT_TOO_LARGE', 'JSON parts must fit within 256 KiB.')
          }
          hash.update(chunk)
          await handle.writeFile(chunk)
        }
        await handle.sync()
        const part = { partId, sha256: hash.digest('hex'), byteLength }
        const old = upload.parts.get(partId)
        if (old && (old.sha256 !== part.sha256 || old.byteLength !== part.byteLength)) {
          throw new CheckpointUploadError('OPERATION_ID_COLLISION', 'A part cannot be replaced with different bytes.')
        }
        await rename(path, join(upload.directory, partId))
        upload.parts.set(partId, part)
        upload.byteLength += byteLength - (old?.byteLength ?? 0)
        return part
      } finally { await handle.close(); await unlink(path).catch(() => undefined) }
    })
  }
  readParts(id: string, declared: readonly CheckpointPart[]): Promise<ReadonlyMap<string, Uint8Array>> {
    return this.lane(id, async () => {
      await this.get(id)
      const upload = this.uploads.get(id)!
      const unique = new Set(declared.map((part) => part.partId))
      if (!declared.length || unique.size !== declared.length || declared.length !== upload.parts.size) {
        throw new CheckpointUploadError('WORKING_COPY_INVALID_CHECKPOINT', 'The commit must name the exact uploaded part set.')
      }
      const parts = new Map<string, Uint8Array>()
      for (const input of declared) {
        const part = checkpointPartSchema.parse(input)
        const actual = upload.parts.get(part.partId)
        if (!actual || actual.sha256 !== part.sha256 || actual.byteLength !== part.byteLength) {
          throw new CheckpointUploadError('WORKING_COPY_INVALID_CHECKPOINT', 'The part digest or byte length changed.')
        }
        const bytes = new Uint8Array(await readFile(join(upload.directory, part.partId)))
        if (bytes.byteLength !== actual.byteLength || createHash('sha256').update(bytes).digest('hex') !== actual.sha256) {
          throw new CheckpointUploadError('WORKING_COPY_INVALID_CHECKPOINT', 'The uploaded part is damaged.')
        }
        parts.set(part.partId, bytes)
      }
      upload.sealed = true
      return parts
    })
  }
  async discard(id: string): Promise<void> {
    const upload = this.uploads.get(id)
    if (!upload) return
    await rm(upload.directory, { recursive: true, force: true })
    this.uploads.delete(id)
  }
  async close(): Promise<void> {
    await Promise.all(this.queues.values())
    await Promise.all([...this.uploads.keys()].map((id) => this.discard(id)))
  }
}
