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
  binding?: WorkingCopyOperationBinding
}

export interface WorkingCopyOperationBinding {
  requestFingerprint: string
  planHash: string
  documentEpoch: string
  sourceContentId: string
  fromWorkingRevision: number
  fromSavedRevision: number
  command: string
  preparation?: { parentOperationId: string; snapshotHash: string }
}

export interface SaveReceipt extends Omit<CheckpointReceipt, 'dirty'> {
  dirty: false
  /** Save advances the original-file version once without changing the checkpoint's working revision. */
  fromSavedRevision: number
}

export type WorkingCopyReceipt = CheckpointReceipt | SaveReceipt

/** All bindings are supplied by the Host after independent save approval validation. */
export interface PromoteWorkingCopyRequest {
  documentEpoch: string
  expectedSavedRevision: number
  expectedWorkingRevision: number
  checkpointId: string
  operationId: string
  requestFingerprint: string
  planHash: string
  result: AgentToolResult
  binding?: WorkingCopyOperationBinding
}

interface SaveIntent {
  schemaVersion: 1
  temporaryName: string
  temporaryIdentity: WorkingCopyBaseline
  oldBaseline: WorkingCopyBaseline
  receipt: SaveReceipt
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
  operations: Record<string, WorkingCopyReceipt>
  sources?: Record<string, { blobHash: string; byteLength: number }>
  saveIntent?: SaveIntent
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
  binding?: WorkingCopyOperationBinding
}

export interface WorkingCopyStore {
  getStatus(): Promise<WorkingCopyStatus>
  readWorkingBytes(): Promise<Uint8Array>
  acquireSource(): Promise<{ sourceContentId: string; bytes: Uint8Array }>
  readSource(sourceContentId: string): Promise<Uint8Array>
  lookupOperationBinding(operationId: string): Promise<WorkingCopyOperationBinding | undefined>
  lookupTerminal(operationId: string, requestFingerprint: string): Promise<WorkingCopyReceipt | undefined>
  commitCheckpoint(request: CheckpointRequest): Promise<CheckpointReceipt>
  promoteWorkingCopy(request: PromoteWorkingCopyRequest): Promise<SaveReceipt>
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

function validBaseline(value: unknown): value is WorkingCopyBaseline {
  return isRecord(value) && isHash(value.sha256) &&
    ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'].every((key) => typeof value[key] === 'string' && /^\d+$/.test(value[key]))
}

function isPromotedFile(actual: WorkingCopyBaseline, temporary: WorkingCopyBaseline): boolean {
  // rename changes ctime on supported filesystems. Device/inode, bytes, size and mtime must
  // remain identical; ctime may only advance. Equal bytes on a replacement inode are never ours.
  return actual.sha256 === temporary.sha256 && actual.device === temporary.device && actual.inode === temporary.inode &&
    actual.size === temporary.size && actual.mtimeNs === temporary.mtimeNs && BigInt(actual.ctimeNs) >= BigInt(temporary.ctimeNs)
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

/** Creates/reopens one Host-authorized document. Checkpoint and save share the same queue. */
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

  const readBlob = async (head: Pick<WorkingCopyHead, 'blobHash' | 'byteLength'>): Promise<Uint8Array> => {
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

  const validateBinding = (binding: WorkingCopyOperationBinding | undefined, receipt: {
    requestFingerprint: string; planHash: string; documentEpoch: string; fromWorkingRevision: number
  }, manifest: Manifest): void => {
    if (binding === undefined) return // Standalone legacy Store receipts are readable, never coordinator authority.
    if (!isRecord(binding) || binding.requestFingerprint !== receipt.requestFingerprint ||
        binding.planHash !== receipt.planHash || binding.documentEpoch !== receipt.documentEpoch ||
        !isHash(binding.sourceContentId) || !Object.hasOwn(manifest.sources ?? {}, binding.sourceContentId) ||
        !isRevision(binding.fromWorkingRevision) || binding.fromWorkingRevision > receipt.fromWorkingRevision ||
        !isRevision(binding.fromSavedRevision) || binding.fromSavedRevision > manifest.savedRevision ||
        !isText(binding.command) ||
        (binding.preparation !== undefined && (!isRecord(binding.preparation) ||
          !isText(binding.preparation.parentOperationId) || !isHash(binding.preparation.snapshotHash)))) {
      invalid('Operation binding does not match its terminal, source or document.')
    }
  }

  const validReceipt = (value: unknown, operationId: string, manifest: Manifest): value is WorkingCopyReceipt => {
    if (!isRecord(value) || !validHead(value) || value.state !== 'committed' ||
        !isText(operationId) || value.operationId !== operationId || value.documentEpoch !== manifest.documentEpoch ||
        !isText(value.requestFingerprint) || !isText(value.planHash) || !isRevision(value.fromWorkingRevision) ||
        !isRevision(value.workingRevision) || value.workingRevision > manifest.workingRevision || !isRevision(value.savedRevision)) return false
    if (value.dirty === true) {
      if (value.workingRevision !== value.fromWorkingRevision + 1 || value.savedRevision > value.fromWorkingRevision) return false
    } else if (value.dirty === false) {
      if (value.workingRevision !== value.fromWorkingRevision || !isRevision(value.fromSavedRevision) ||
          value.savedRevision !== value.fromSavedRevision + 1) return false
    } else return false
    boundedResult(value.result, maxResultByteLength)
    return true
  }

  const loadManifest = async (): Promise<Manifest> => {
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
          !isText(parsed.documentEpoch) || !validBaseline(parsed.baseline) ||
          !isRevision(parsed.savedRevision) || !isRevision(parsed.workingRevision) || parsed.workingRevision < parsed.savedRevision ||
          typeof parsed.dirty !== 'boolean' || !isRecord(parsed.operations) ||
          (parsed.head !== null && !validHead(parsed.head))) throw new Error('Invalid manifest schema or document binding')
      const manifest = parsed as unknown as Manifest
      if (manifest.sources !== undefined) {
        if (!isRecord(manifest.sources)) throw new Error('Invalid source index')
        for (const [id, source] of Object.entries(manifest.sources)) {
          if (!isHash(id) || !isRecord(source) || source.blobHash !== id ||
              !isRevision(source.byteLength) || source.byteLength > maxByteLength) throw new Error('Invalid source binding')
        }
      }
      const operations = Object.entries(manifest.operations)
      for (const [operationId, receipt] of operations) {
        if (!validReceipt(receipt, operationId, manifest) || receipt.savedRevision > manifest.savedRevision) throw new Error('Invalid operation receipt')
        validateBinding(receipt.binding, receipt, manifest)
        if (!receipt.dirty) {
          const checkpoint = operations.find(([, entry]) => entry.dirty && entry.checkpointId === receipt.checkpointId)?.[1]
          if (checkpoint === undefined || checkpoint.workingRevision !== receipt.workingRevision ||
              checkpoint.savedRevision !== receipt.fromSavedRevision || checkpoint.blobHash !== receipt.blobHash ||
              checkpoint.byteLength !== receipt.byteLength ||
              (receipt.savedRevision === manifest.savedRevision && (receipt.blobHash !== manifest.baseline.sha256 ||
                String(receipt.byteLength) !== manifest.baseline.size))) throw new Error('Save terminal is not bound to its checkpoint and baseline')
        }
      }
      if (manifest.head === null) {
        if (manifest.dirty || (operations.length === 0 ? manifest.workingRevision !== manifest.savedRevision :
          !operations.some(([, receipt]) => !receipt.dirty && receipt.savedRevision === manifest.savedRevision &&
            receipt.workingRevision === manifest.workingRevision))) throw new Error('Invalid empty head')
      } else {
        const latest = operations.find(([, receipt]) => receipt.dirty && receipt.checkpointId === manifest.head!.checkpointId)?.[1]
        if (!manifest.dirty || latest === undefined || latest.workingRevision !== manifest.workingRevision ||
            latest.savedRevision !== manifest.savedRevision || latest.blobHash !== manifest.head.blobHash ||
            latest.byteLength !== manifest.head.byteLength) throw new Error('Head is not bound to its terminal')
        await readBlob(manifest.head)
      }
      if (manifest.saveIntent !== undefined) {
        const intent = manifest.saveIntent
        if (!isRecord(intent) || intent.schemaVersion !== 1 || typeof intent.temporaryName !== 'string' ||
            !/^\.nexusdesk-save-[a-f0-9-]{36}\.tmp$/.test(intent.temporaryName) ||
            !validBaseline(intent.temporaryIdentity) || !validBaseline(intent.oldBaseline) ||
            !sameBaseline(intent.oldBaseline, manifest.baseline) || !isRecord(intent.receipt) ||
            !validReceipt(intent.receipt, String(intent.receipt.operationId), manifest) || intent.receipt.dirty !== false ||
            intent.receipt.fromSavedRevision !== manifest.savedRevision || intent.receipt.workingRevision !== manifest.workingRevision ||
            !manifest.dirty || manifest.head === null || intent.receipt.checkpointId !== manifest.head.checkpointId ||
            intent.receipt.blobHash !== manifest.head.blobHash || intent.receipt.byteLength !== manifest.head.byteLength ||
            intent.temporaryIdentity.sha256 !== manifest.head.blobHash || intent.temporaryIdentity.size !== String(manifest.head.byteLength) ||
            Object.hasOwn(manifest.operations, intent.receipt.operationId)) throw new Error('Invalid save intent')
        validateBinding(intent.receipt.binding, intent.receipt, manifest)
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

  const reconcileSave = async (manifest: Manifest): Promise<Manifest> => {
    const intent = manifest.saveIntent
    if (intent === undefined) return manifest
    const temporaryPath = join(dirname(authorizedPath), intent.temporaryName)
    try {
      let original = await readBaseline(authorizedPath)
      if (sameBaseline(original.identity, intent.oldBaseline)) {
        const temporary = await readBaseline(temporaryPath)
        if (!sameBaseline(temporary.identity, intent.temporaryIdentity)) {
          throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The save temporary file changed; recovery evidence was preserved.')
        }
        await confirmReceiptDurability(directory)
        // Revalidate immediately before replacing; this queue excludes other Host mutations.
        // Portable rename has no compare-and-swap: this is not a cross-process writer lease.
        await currentBaseline(manifest)
        await rename(temporaryPath, authorizedPath)
      } else if (!isPromotedFile(original.identity, intent.temporaryIdentity)) {
        throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The original no longer matches either side of the save intent; recovery evidence was preserved.')
      }
      await syncDirectory(dirname(authorizedPath))
      original = await readBaseline(authorizedPath)
      if (!isPromotedFile(original.identity, intent.temporaryIdentity)) {
        throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The original changed during save; recovery evidence was preserved.')
      }
      const { saveIntent: _intent, ...previous } = manifest
      const finished: Manifest = { ...previous, baseline: original.identity,
        savedRevision: intent.receipt.savedRevision, dirty: false, head: null,
        operations: { ...manifest.operations, [intent.receipt.operationId]: intent.receipt } }
      await publishManifest(manifestPath, serializeManifest(finished, maxManifestByteLength))
      return finished
    } catch (cause) {
      if (cause instanceof WorkingCopyStoreError && cause.code === 'REVISION_CONFLICT') throw cause
      if (codeOf(cause) === 'ENOENT') {
        throw new WorkingCopyStoreError('REVISION_CONFLICT', 'A save intent file is missing; recovery evidence was preserved.', { cause })
      }
      throw new WorkingCopyStoreError('WORKING_COPY_OUTCOME_UNKNOWN', 'A durable save intent remains; reconcile its outcome before retrying.', { cause })
    }
  }

  const load = async () => reconcileSave(await loadManifest())

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
        const { schemaVersion: _version, authorizedPath: _path, operations: _operations, saveIntent: _intent, sources: _sources, ...status } = manifest
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
    acquireSource() {
      return enqueue(manifestPath, async () => {
        const manifest = await load()
        const baseline = await currentBaseline(manifest)
        const bytes = manifest.head === null ? baseline.bytes : await readBlob(manifest.head)
        if (bytes.byteLength > maxByteLength) invalid('Source exceeds the file byte limit.')
        const sourceContentId = sha256(bytes)
        const source = { blobHash: sourceContentId, byteLength: bytes.byteLength }
        if (Object.hasOwn(manifest.sources ?? {}, sourceContentId)) {
          return { sourceContentId, bytes: await readBlob(source) }
        }
        const json = serializeManifest({ ...manifest, sources: { ...manifest.sources, [sourceContentId]: source } }, maxManifestByteLength)
        const temporary = join(blobs, '.source-' + randomUUID() + '.tmp')
        try {
          const handle = await open(temporary, 'wx', 0o600)
          try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
          try { await link(temporary, join(blobs, sourceContentId)) } catch (error) {
            if (codeOf(error) !== 'EEXIST') throw error
          }
          await readBlob(source)
          await syncDirectory(blobs)
          await currentBaseline(manifest)
          await publishManifest(manifestPath, json)
          return { sourceContentId, bytes }
        } catch (cause) {
          if (cause instanceof WorkingCopyStoreError) throw cause
          throw new WorkingCopyStoreError('WORKING_COPY_PERSIST_FAILED', 'Could not snapshot the immutable source.', { cause })
        } finally { await unlink(temporary).catch(() => undefined) }
      })
    },
    readSource(sourceContentId) {
      return enqueue(manifestPath, async () => {
        const manifest = await load()
        if (!isHash(sourceContentId) || !Object.hasOwn(manifest.sources ?? {}, sourceContentId)) invalid('Unknown document source.')
        return readBlob(manifest.sources![sourceContentId]!)
      })
    },
    lookupOperationBinding(operationId) {
      return enqueue(manifestPath, async () => {
        const manifest = await load()
        await currentBaseline(manifest)
        const receipt = Object.hasOwn(manifest.operations, operationId) ? manifest.operations[operationId] : undefined
        return receipt?.binding === undefined ? undefined : clone(receipt.binding)
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
    promoteWorkingCopy(request) {
      let input: PromoteWorkingCopyRequest
      try {
        if (!isText(request.documentEpoch) || !isText(request.operationId) || !isText(request.requestFingerprint) ||
            !isText(request.planHash) || !isText(request.checkpointId) || !isRevision(request.expectedSavedRevision) ||
            !isRevision(request.expectedWorkingRevision)) invalid('Invalid save metadata.')
        input = { ...request, result: boundedResult(request.result, maxResultByteLength),
          ...(request.binding === undefined ? {} : { binding: clone(request.binding) }) }
      } catch (error) { return Promise.reject(error) }
      return enqueue(manifestPath, async () => {
        const manifest = await load()
        await currentBaseline(manifest)
        if (input.documentEpoch !== manifest.documentEpoch) throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The document epoch changed.')
        const existing = Object.hasOwn(manifest.operations, input.operationId) ? manifest.operations[input.operationId] : undefined
        if (existing !== undefined) {
          if (existing.dirty || existing.requestFingerprint !== input.requestFingerprint || existing.planHash !== input.planHash ||
              existing.checkpointId !== input.checkpointId || existing.fromSavedRevision !== input.expectedSavedRevision ||
              existing.fromWorkingRevision !== input.expectedWorkingRevision) {
            throw new WorkingCopyStoreError('OPERATION_ID_COLLISION', 'Operation ID is bound to a different save or checkpoint.')
          }
          await readBlob(existing)
          await confirmReceiptDurability(directory)
          return clone(existing)
        }
        if (manifest.savedRevision !== input.expectedSavedRevision || manifest.workingRevision !== input.expectedWorkingRevision ||
            !manifest.dirty || manifest.head === null || manifest.head.checkpointId !== input.checkpointId) {
          throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The approved saved revision or working checkpoint changed.')
        }
        const bytes = await readBlob(manifest.head)
        const receipt: SaveReceipt = { ...manifest.head, state: 'committed', documentEpoch: manifest.documentEpoch,
          operationId: input.operationId, requestFingerprint: input.requestFingerprint, planHash: input.planHash,
          fromWorkingRevision: manifest.workingRevision, workingRevision: manifest.workingRevision,
          fromSavedRevision: manifest.savedRevision, savedRevision: manifest.savedRevision + 1,
          dirty: false, result: input.result }
        if (input.binding !== undefined) receipt.binding = input.binding
        validateBinding(receipt.binding, receipt, manifest)
        const temporaryName = `.nexusdesk-save-${randomUUID()}.tmp`
        const temporaryPath = join(dirname(authorizedPath), temporaryName)
        let preserveTemporary = false
        try {
          const handle = await open(temporaryPath, 'wx', 0o600)
          try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
          const temporary = await readBaseline(temporaryPath)
          if (temporary.identity.sha256 !== receipt.blobHash || temporary.bytes.byteLength !== receipt.byteLength) {
            throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The save temporary bytes changed before intent publication.')
          }
          // Persist the temporary pathname before the intent may promise it can finish after a crash.
          await syncDirectory(dirname(authorizedPath))
          await currentBaseline(manifest)
          const intent: SaveIntent = { schemaVersion: 1, temporaryName, temporaryIdentity: temporary.identity,
            oldBaseline: manifest.baseline, receipt }
          const pending: Manifest = { ...manifest, saveIntent: intent }
          const pendingJson = serializeManifest(pending, maxManifestByteLength)
          // A full ledger must not strand a save that can never publish its final receipt.
          serializeManifest({ ...manifest, baseline: temporary.identity, savedRevision: receipt.savedRevision,
            head: null, dirty: false, operations: { ...manifest.operations, [input.operationId]: receipt } }, maxManifestByteLength)
          try {
            await publishManifest(manifestPath, pendingJson)
            preserveTemporary = true
          } catch (cause) {
            if (codeOf(cause) === 'WORKING_COPY_OUTCOME_UNKNOWN') preserveTemporary = true
            throw cause
          }
          await reconcileSave(pending)
          return clone(receipt)
        } catch (cause) {
          if (cause instanceof WorkingCopyStoreError) throw cause
          throw new WorkingCopyStoreError(preserveTemporary ? 'WORKING_COPY_OUTCOME_UNKNOWN' : 'WORKING_COPY_PERSIST_FAILED',
            'Could not finish the approved working-copy save.', { cause })
        } finally {
          if (!preserveTemporary) await unlink(temporaryPath).catch(() => undefined)
        }
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
        input = { ...request, bytes: new Uint8Array(request.bytes), result: boundedResult(request.result, maxResultByteLength),
          ...(request.binding === undefined ? {} : { binding: clone(request.binding) }) }
      } catch (error) { return Promise.reject(error) }
      return enqueue(manifestPath, async () => {
        const manifest = await load()
        await currentBaseline(manifest)
        if (input.documentEpoch !== manifest.documentEpoch) throw new WorkingCopyStoreError('REVISION_CONFLICT', 'The document epoch changed.')
        const existing = Object.hasOwn(manifest.operations, input.operationId) ? manifest.operations[input.operationId] : undefined
        if (existing !== undefined) {
          if (!existing.dirty || existing.requestFingerprint !== input.requestFingerprint || existing.planHash !== input.planHash) {
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
        if (input.binding !== undefined) receipt.binding = input.binding
        validateBinding(receipt.binding, receipt, manifest)
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
              !Object.values(manifest.operations).some((entry) => entry.blobHash === receipt.blobHash) &&
              !Object.hasOwn(manifest.sources ?? {}, receipt.blobHash)) {
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
