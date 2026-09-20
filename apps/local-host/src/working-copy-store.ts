import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { link, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { parseAgentToolResult, type AgentToolResult } from '@nexusdesk/protocol'

export interface WorkingCopyBaseline {
  sha256: string
  device: string
  inode: string
  size: string
  mtimeNs: string
  ctimeNs: string
}

export interface WorkingCopyHead {
  checkpointId: string
  blobHash: string
  byteLength: number
}

export interface CheckpointReceipt extends WorkingCopyHead {
  state: 'committed'
  documentEpoch: string
  operationId: string
  requestFingerprint: string
  planHash: string
  fromWorkingRevision: number
  workingRevision: number
  savedRevision: number
  dirty: true
  result: AgentToolResult
}

export interface WorkingCopyStatus {
  documentId: string
  editorType: 'docs' | 'sheets' | 'pdf'
  documentEpoch: string
  baseline: WorkingCopyBaseline
  savedRevision: number
  workingRevision: number
  head: WorkingCopyHead | null
  dirty: boolean
  recoveryState: 'ready' | 'conflict'
}

interface Manifest extends Omit<WorkingCopyStatus, 'recoveryState'> {
  schemaVersion: 1
  authorizedPath: string
  operations: Record<string, CheckpointReceipt>
}

export interface WorkingCopyStoreOptions {
  /** Both paths come from Host authorization/configuration, never an upload. */
  rootDirectory: string
  authorizedPath: string
  documentId: string
  editorType: WorkingCopyStatus['editorType']
  initialSavedRevision?: number
  maxByteLength?: number
  maxResultByteLength?: number
  /** Host storage policy may lower, but never exceed, the 64 MiB manifest ceiling. */
  maxManifestByteLength?: number
}

export interface CheckpointRequest {
  documentEpoch: string
  expectedSavedRevision: number
  expectedWorkingRevision: number
  /** The Host supplies these exact bindings after reservation/approval validation. */
  operationId: string
  requestFingerprint: string
  planHash: string
  payloadHash: string
  payloadByteLength: number
  /** Complete bytes already validated by the format driver. The store verifies transport integrity. */
  bytes: Uint8Array
  result: AgentToolResult
}

export interface WorkingCopyStore {
  getStatus(): Promise<WorkingCopyStatus>
  readWorkingBytes(): Promise<Uint8Array>
  lookupTerminal(operationId: string, requestFingerprint: string): Promise<CheckpointReceipt | undefined>
  commitCheckpoint(request: CheckpointRequest): Promise<CheckpointReceipt>
}

export type WorkingCopyStoreErrorCode =
  | 'REVISION_CONFLICT'
  | 'OPERATION_ID_COLLISION'
  | 'WORKING_COPY_INVALID_CHECKPOINT'
  | 'WORKING_COPY_PERSIST_FAILED'
  | 'WORKING_COPY_OUTCOME_UNKNOWN'
  | 'WORKING_COPY_RECOVERY_INVALID'

export class WorkingCopyStoreError extends Error {
  constructor(readonly code: WorkingCopyStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkingCopyStoreError'
  }
}

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const queues = new Map<string, Promise<void>>()
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code

/** Shared by all instances for this document in one Host process. No cross-process writer lease. */
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const pending = (queues.get(key) ?? Promise.resolve()).then(task)
  const tail = pending.then(() => undefined, () => undefined)
  queues.set(key, tail)
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return pending
}

function invalid(message: string): never {
  throw new WorkingCopyStoreError('WORKING_COPY_INVALID_CHECKPOINT', message)
}

function boundedResult(value: unknown, limit: number): AgentToolResult {
  try {
    // Reject engines, typed arrays, cycles, and other non-JSON objects instead of silently losing them.
    const ancestors = new Set<object>()
    const validate = (entry: unknown, depth: number): void => {
      if (depth > 64) throw new Error('Result is too deeply nested')
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
        throw new Error('Result must contain JSON values only')
      }
      if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error('Non-finite number')
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const prototype = Object.getPrototypeOf(entry)
        if (prototype !== Object.prototype && prototype !== null) throw new Error('Non-JSON object')
      }
      if (entry !== null && typeof entry === 'object') {
        if (ancestors.has(entry)) throw new Error('Cyclic result')
        ancestors.add(entry)
        for (const child of Object.values(entry)) validate(child, depth + 1)
        ancestors.delete(entry)
      }
    }
    validate(value, 0)
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json) > limit) invalid('The result envelope exceeds its byte limit.')
    const parsed = parseAgentToolResult(JSON.parse(json))
    if (!parsed.ok || parsed.verification?.passed === false) invalid('A checkpoint requires a successful verified result.')
    return parsed
  } catch (cause) {
    if (cause instanceof WorkingCopyStoreError) throw cause
    throw new WorkingCopyStoreError('WORKING_COPY_INVALID_CHECKPOINT', 'Invalid checkpoint result envelope.', { cause })
  }
}

function baselineIdentity(info: BigIntStats, hash: string): WorkingCopyBaseline {
  return { sha256: hash, device: String(info.dev), inode: String(info.ino), size: String(info.size),
    mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) }
}

function sameBaseline(left: WorkingCopyBaseline, right: WorkingCopyBaseline): boolean {
  return (Object.keys(left) as (keyof WorkingCopyBaseline)[]).every((key) => left[key] === right[key])
}

async function readBaseline(path: string): Promise<{ bytes: Uint8Array; identity: WorkingCopyBaseline }> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('The authorized source is not a regular file.')
    const bytes = new Uint8Array(await handle.readFile())
    const hash = sha256(bytes)
    const identity = baselineIdentity(await handle.stat({ bigint: true }), hash)
    if (!sameBaseline(baselineIdentity(before, hash), identity) ||
        !sameBaseline(identity, baselineIdentity(await stat(path, { bigint: true }), hash)) ||
        String(bytes.byteLength) !== identity.size) {
      throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The original file changed while reading its baseline.')
    }
    return { bytes, identity }
  } finally { await handle.close() }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function makeDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 })
  if (firstCreated === undefined) return
  let current = path
  while (true) {
    await syncDirectory(current)
    if (current === dirname(firstCreated)) break
    current = dirname(current)
  }
}

function serializeManifest(manifest: Manifest, maxByteLength: number): string {
  const json = JSON.stringify(manifest)
  if (Buffer.byteLength(json) > maxByteLength) invalid('The durable operation ledger is full.')
  return json
}

async function confirmReceiptDurability(directory: string): Promise<void> {
  try { await syncDirectory(directory) } catch (cause) {
    throw new WorkingCopyStoreError('WORKING_COPY_OUTCOME_UNKNOWN',
      'The manifest receipt exists but directory durability is still unconfirmed; do not repeat the mutation.', { cause })
  }
}

/** The rename is the sole commit point; a later sync error has an unknown durable outcome. */
async function publishManifest(path: string, json: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.manifest-${randomUUID()}.tmp`)
  let published = false
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try { await handle.writeFile(json); await handle.sync() } finally { await handle.close() }
    await rename(temporaryPath, path)
    published = true
    await syncDirectory(dirname(path))
  } catch (cause) {
    throw new WorkingCopyStoreError(published ? 'WORKING_COPY_OUTCOME_UNKNOWN' : 'WORKING_COPY_PERSIST_FAILED',
      published ? 'Manifest published; verify its durable receipt before retrying the mutation.' : 'Could not publish the working copy manifest.', { cause })
  } finally { await unlink(temporaryPath).catch(() => undefined) }
}

/** Creates/reopens one Host-authorized document. Save/promote must later use this same queue. */
export async function createWorkingCopyStore(options: WorkingCopyStoreOptions): Promise<WorkingCopyStore> {
  const maxByteLength = options.maxByteLength ?? 128 * 1024 * 1024
  const maxResultByteLength = options.maxResultByteLength ?? 256 * 1024
  const maxManifestByteLength = options.maxManifestByteLength ?? MAX_MANIFEST_BYTES
  const initialSavedRevision = options.initialSavedRevision ?? 1
  if (!isText(options.documentId) || !['docs', 'sheets', 'pdf'].includes(options.editorType) ||
      !isRevision(initialSavedRevision) || !isRevision(maxByteLength) || maxByteLength === 0 ||
      !isRevision(maxResultByteLength) || maxResultByteLength === 0 ||
      !isRevision(maxManifestByteLength) || maxManifestByteLength === 0 || maxManifestByteLength > MAX_MANIFEST_BYTES) {
    invalid('Invalid Host working-copy configuration.')
  }

  // Preserve the authorized pathname so replacing the file still locates its original recovery record.
  const authorizedPath = resolve(options.authorizedPath)
  await makeDirectory(resolve(options.rootDirectory))
  const root = await realpath(options.rootDirectory)
  const directory = join(root, sha256(JSON.stringify([authorizedPath, options.documentId, options.editorType])))
  const manifestPath = join(directory, 'manifest.json')
  const blobs = join(directory, 'blobs')

  const readBlob = async (head: WorkingCopyHead): Promise<Uint8Array> => {
    try {
      const path = join(blobs, head.blobHash)
      const info = await stat(path)
      if (!info.isFile() || info.size !== head.byteLength || info.size > maxByteLength) throw new Error('Invalid blob size')
      const bytes = new Uint8Array(await readFile(path))
      if (bytes.byteLength !== head.byteLength || sha256(bytes) !== head.blobHash) throw new Error('Invalid blob digest')
      return bytes
    } catch (cause) {
      throw new WorkingCopyStoreError('WORKING_COPY_RECOVERY_INVALID', 'The checkpoint blob is missing or damaged; recovery evidence was preserved.', { cause })
    }
  }

  const validHead = (value: unknown): value is WorkingCopyHead => isRecord(value) && isText(value.checkpointId) &&
    isHash(value.blobHash) && isRevision(value.byteLength) && value.byteLength <= maxByteLength

  const load = async (): Promise<Manifest> => {
    let raw: string
    try {
      if ((await stat(manifestPath)).size > maxManifestByteLength) throw new Error('Oversized manifest')
      raw = await readFile(manifestPath, 'utf8')
    } catch (cause) {
      if (codeOf(cause) === 'ENOENT') throw cause
      throw new WorkingCopyStoreError('WORKING_COPY_RECOVERY_INVALID', 'Cannot read the recovery manifest.', { cause })
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.documentId !== options.documentId ||
          parsed.editorType !== options.editorType || parsed.authorizedPath !== authorizedPath ||
          !isText(parsed.documentEpoch) || !isRecord(parsed.baseline) || !isHash(parsed.baseline.sha256) ||
          !['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'].every((key) => typeof parsed.baseline === 'object' &&
            typeof (parsed.baseline as Record<string, unknown>)[key] === 'string' && /^\d+$/.test(String((parsed.baseline as Record<string, unknown>)[key]))) ||
          !isRevision(parsed.savedRevision) || !isRevision(parsed.workingRevision) || parsed.workingRevision < parsed.savedRevision ||
          typeof parsed.dirty !== 'boolean' || !isRecord(parsed.operations) ||
          (parsed.head !== null && !validHead(parsed.head))) throw new Error('Invalid manifest schema or document binding')
      const manifest = parsed as unknown as Manifest
      const operations = Object.entries(manifest.operations)
      for (const [operationId, receipt] of operations) {
        if (!isRecord(receipt) || !validHead(receipt) || receipt.state !== 'committed' ||
            !isText(operationId) || receipt.operationId !== operationId || receipt.documentEpoch !== manifest.documentEpoch ||
            !isText(receipt.requestFingerprint) || !isText(receipt.planHash) || receipt.dirty !== true ||
            !isRevision(receipt.fromWorkingRevision) || receipt.workingRevision !== receipt.fromWorkingRevision + 1 ||
            receipt.workingRevision > manifest.workingRevision || !isRevision(receipt.savedRevision) ||
            receipt.savedRevision > receipt.fromWorkingRevision) throw new Error('Invalid operation receipt')
        boundedResult(receipt.result, maxResultByteLength)
      }
      if (manifest.head === null) {
        if (manifest.dirty || operations.length !== 0 || manifest.workingRevision !== manifest.savedRevision) throw new Error('Invalid empty head')
      } else {
        const latest = operations.find(([, receipt]) => receipt.checkpointId === manifest.head!.checkpointId)?.[1]
        if (!manifest.dirty || latest === undefined || latest.workingRevision !== manifest.workingRevision ||
            latest.savedRevision !== manifest.savedRevision || latest.blobHash !== manifest.head.blobHash ||
            latest.byteLength !== manifest.head.byteLength) throw new Error('Head is not bound to its terminal')
        await readBlob(manifest.head)
      }
      return manifest
    } catch (cause) {
      throw new WorkingCopyStoreError('WORKING_COPY_RECOVERY_INVALID', 'Invalid recovery manifest or blob; recovery evidence was preserved.', { cause })
    }
  }

  const currentBaseline = async (manifest: Manifest) => {
    try {
      const current = await readBaseline(authorizedPath)
      if (!sameBaseline(current.identity, manifest.baseline)) throw new Error('Baseline mismatch')
      return current
    } catch (cause) {
      throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The original file changed or is unavailable; the working copy was preserved.', { cause })
    }
  }

  await enqueue(manifestPath, async () => {
    await makeDirectory(blobs)
    try { await load() } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
      if ((await readdir(blobs)).length > 0) {
        throw new WorkingCopyStoreError('WORKING_COPY_RECOVERY_INVALID', 'The manifest is missing but recovery bytes remain; evidence was preserved.')
      }
      const baseline = await readBaseline(authorizedPath)
      await publishManifest(manifestPath, serializeManifest({
        schemaVersion: 1, authorizedPath, documentId: options.documentId, editorType: options.editorType,
        documentEpoch: randomUUID(), baseline: baseline.identity,
        savedRevision: initialSavedRevision, workingRevision: initialSavedRevision,
        dirty: false, head: null, operations: {},
      }, maxManifestByteLength))
    }
  })

  return {
    getStatus() {
      return enqueue(manifestPath, async () => {
        const manifest = await load()
        let recoveryState: WorkingCopyStatus['recoveryState'] = 'ready'
        try { await currentBaseline(manifest) } catch { recoveryState = 'conflict' }
        const { schemaVersion: _version, authorizedPath: _path, operations: _operations, ...status } = manifest
        return { ...status, recoveryState }
      })
    },
    readWorkingBytes() {
      return enqueue(manifestPath, async () => {
        const manifest = await load()
        const baseline = await currentBaseline(manifest)
        return manifest.head === null ? baseline.bytes : readBlob(manifest.head)
      })
    },
    lookupTerminal(operationId, requestFingerprint) {
      return enqueue(manifestPath, async () => {
        const manifest = await load()
        await currentBaseline(manifest)
        const receipt = Object.hasOwn(manifest.operations, operationId) ? manifest.operations[operationId] : undefined
        if (receipt === undefined) return undefined
        if (receipt.requestFingerprint !== requestFingerprint) throw new WorkingCopyStoreError('OPERATION_ID_COLLISION', 'Operation ID is bound to a different request.')
        await readBlob(receipt)
        await confirmReceiptDurability(directory)
        return clone(receipt)
      })
    },
    commitCheckpoint(request) {
      // Capture inputs synchronously, before any queue wait, so callers cannot change the committed snapshot.
      let input: CheckpointRequest
      try {
        if (!(request.bytes instanceof Uint8Array) || request.bytes.byteLength > maxByteLength ||
            !isText(request.operationId) || !isText(request.requestFingerprint) || !isText(request.planHash) ||
            !isText(request.documentEpoch) || !isRevision(request.expectedSavedRevision) ||
            !isRevision(request.expectedWorkingRevision) || !isHash(request.payloadHash) ||
            !isRevision(request.payloadByteLength)) invalid('Invalid checkpoint metadata or size.')
        input = { ...request, bytes: new Uint8Array(request.bytes), result: boundedResult(request.result, maxResultByteLength) }
      } catch (error) { return Promise.reject(error) }
      return enqueue(manifestPath, async () => {
        const manifest = await load()
        await currentBaseline(manifest)
        if (input.documentEpoch !== manifest.documentEpoch) throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The document epoch changed.')
        const existing = Object.hasOwn(manifest.operations, input.operationId) ? manifest.operations[input.operationId] : undefined
        if (existing !== undefined) {
          if (existing.requestFingerprint !== input.requestFingerprint || existing.planHash !== input.planHash) {
            throw new WorkingCopyStoreError('OPERATION_ID_COLLISION', 'Operation ID is bound to a different request or plan.')
          }
          await readBlob(existing)
          await confirmReceiptDurability(directory)
          return clone(existing)
        }
        if (input.expectedSavedRevision !== manifest.savedRevision || input.expectedWorkingRevision !== manifest.workingRevision) {
          throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The saved or working revision changed.')
        }
        if (input.bytes.byteLength !== input.payloadByteLength || sha256(input.bytes) !== input.payloadHash ||
            !Number.isSafeInteger(manifest.workingRevision + 1)) invalid('Checkpoint bytes do not match their declared size/hash or revision limit.')
        const receipt: CheckpointReceipt = {
          state: 'committed', documentEpoch: manifest.documentEpoch,
          operationId: input.operationId, requestFingerprint: input.requestFingerprint, planHash: input.planHash,
          fromWorkingRevision: manifest.workingRevision, workingRevision: manifest.workingRevision + 1,
          savedRevision: manifest.savedRevision, dirty: true, checkpointId: randomUUID(),
          blobHash: input.payloadHash, byteLength: input.bytes.byteLength, result: input.result,
        }
        // Capacity rejection must precede all blob writes, including the temporary file.
        const candidateJson = serializeManifest({
          ...manifest, workingRevision: receipt.workingRevision, dirty: true,
          head: { checkpointId: receipt.checkpointId, blobHash: receipt.blobHash, byteLength: receipt.byteLength },
          operations: { ...manifest.operations, [input.operationId]: receipt },
        }, maxManifestByteLength)
        const temporaryPath = join(blobs, `.blob-${randomUUID()}.tmp`)
        const blobPath = join(blobs, receipt.blobHash)
        let createdBlob = false
        let manifestPublished = false
        try {
          const handle = await open(temporaryPath, 'wx', 0o600)
          try { await handle.writeFile(input.bytes); await handle.sync() } finally { await handle.close() }
          try {
            await link(temporaryPath, blobPath)
            createdBlob = true
          } catch (error) {
            if (codeOf(error) !== 'EEXIST') throw error
            await readBlob(receipt)
          }
          await syncDirectory(blobs)
          // Blob creation may take time; recheck the authorized file before publishing the new head.
          await currentBaseline(manifest)
          await publishManifest(manifestPath, candidateJson)
          manifestPublished = true
          return clone(receipt)
        } catch (cause) {
          // Reclaim only this attempt's new, definitely uncommitted blob. Existing/shared blobs and
          // unknown publication outcomes remain intact. Process crashes can leave one blob/temp per
          // interrupted attempt; those require a later manifest/lease-aware GC, never blind deletion.
          if (createdBlob && !manifestPublished && codeOf(cause) !== 'WORKING_COPY_OUTCOME_UNKNOWN' &&
              !Object.values(manifest.operations).some((entry) => entry.blobHash === receipt.blobHash)) {
            try {
              await unlink(blobPath)
              await syncDirectory(blobs)
            } catch (cleanupCause) {
              throw new WorkingCopyStoreError(cause instanceof WorkingCopyStoreError ? cause.code : 'WORKING_COPY_PERSIST_FAILED',
                'Checkpoint failed and its unreferenced blob could not be fully reclaimed; recovery evidence was preserved.',
                { cause: new AggregateError([cause, cleanupCause]) })
            }
          }
          if (cause instanceof WorkingCopyStoreError) throw cause
          throw new WorkingCopyStoreError('WORKING_COPY_PERSIST_FAILED', 'Could not persist checkpoint bytes.', { cause })
        } finally { await unlink(temporaryPath).catch(() => undefined) }
      })
    },
  }
}
