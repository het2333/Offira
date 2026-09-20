import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWorkingCopyStore, type CheckpointRequest } from '../src/working-copy-store'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) }
})

const directories: string[] = []
const encode = (text: string) => new TextEncoder().encode(text)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

afterEach(async () => {
  vi.mocked(fs.rename).mockReset()
  vi.mocked(fs.rename).mockImplementation((await vi.importActual<typeof fs>('node:fs/promises')).rename)
  vi.mocked(fs.open).mockReset()
  vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof fs>('node:fs/promises')).open)
  await Promise.all(directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

async function fixture(options: { maxByteLength?: number; maxResultByteLength?: number; maxManifestByteLength?: number } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'nexusdesk-working-copy-'))
  directories.push(directory)
  const authorizedPath = join(directory, 'source.bin')
  await fs.writeFile(authorizedPath, 'saved original')
  const config = {
    rootDirectory: join(directory, 'recovery'), authorizedPath,
    documentId: 'document-1', editorType: 'docs' as const, ...options,
  }
  const store = await createWorkingCopyStore(config)
  const initial = await store.getStatus()
  const request = (text = 'manual and agent edits', overrides: Partial<CheckpointRequest> = {}): CheckpointRequest => {
    const bytes = encode(text)
    return {
      documentEpoch: initial.documentEpoch,
      expectedSavedRevision: 1, expectedWorkingRevision: 1,
      operationId: 'operation-1', requestFingerprint: 'exact-request-1', planHash: 'approved-plan-1',
      payloadHash: hash(bytes), payloadByteLength: bytes.byteLength, bytes,
      result: { ok: true, summary: 'Applied one change', warnings: [], verification: { passed: true, issues: [] } },
      ...overrides,
    }
  }
  return { directory, authorizedPath, config, store, initial, request }
}

async function manifestPath(root: string): Promise<string> {
  const names = await fs.readdir(root)
  expect(names).toHaveLength(1)
  return join(root, names[0], 'manifest.json')
}

describe('Host durable WorkingCopyStore', () => {
  it('atomically recovers working bytes and their terminal across a fresh Host instance', async () => {
    const { store, config, authorizedPath, initial, request } = await fixture()
    expect(initial).toMatchObject({ savedRevision: 1, workingRevision: 1, head: null, dirty: false, recoveryState: 'ready' })
    const receipt = await store.commitCheckpoint(request())
    const reopened = await createWorkingCopyStore(config)
    expect(await fs.readFile(authorizedPath, 'utf8')).toBe('saved original')
    expect(await reopened.readWorkingBytes()).toEqual(encode('manual and agent edits'))
    expect(await reopened.lookupTerminal('operation-1', 'exact-request-1')).toEqual(receipt)
    expect(await reopened.getStatus()).toMatchObject({
      documentEpoch: initial.documentEpoch, savedRevision: 1, workingRevision: 2, dirty: true,
      head: { checkpointId: receipt.checkpointId, blobHash: hash(encode('manual and agent edits')) },
    })
    const manifest = JSON.parse(await fs.readFile(await manifestPath(config.rootDirectory), 'utf8'))
    expect(manifest).toMatchObject({ schemaVersion: 1, documentId: 'document-1', editorType: 'docs',
      baseline: { sha256: hash(encode('saved original')), size: '14' },
      operations: { 'operation-1': { state: 'committed', planHash: 'approved-plan-1', result: { ok: true } } },
    })
    expect(await fs.stat(join(config.rootDirectory, (await fs.readdir(config.rootDirectory))[0], 'blobs', receipt.blobHash))).toMatchObject({ size: 22 })
  })

  it('coalesces identical concurrent commits and never rolls the head back when replaying older receipts', async () => {
    const { store, config, request } = await fixture()
    const first = request()
    const [a, b] = await Promise.all([store.commitCheckpoint(first), store.commitCheckpoint(first)])
    expect(b).toEqual(a)
    await store.commitCheckpoint(request('second checkpoint', {
      operationId: 'operation-2', requestFingerprint: 'exact-request-2', expectedWorkingRevision: 2,
    }))
    const reopened = await createWorkingCopyStore(config)
    expect(await reopened.commitCheckpoint(first)).toEqual(a)
    expect(await reopened.readWorkingBytes()).toEqual(encode('second checkpoint'))
    expect((await reopened.getStatus()).workingRevision).toBe(3)
  })

  it('rejects operation collisions without altering the head or stored terminal', async () => {
    const { store, request } = await fixture()
    const receipt = await store.commitCheckpoint(request())
    await expect(store.commitCheckpoint(request('changed', { requestFingerprint: 'different' })))
      .rejects.toMatchObject({ code: 'OPERATION_ID_COLLISION' })
    await expect(store.lookupTerminal('operation-1', 'different')).rejects.toMatchObject({ code: 'OPERATION_ID_COLLISION' })
    expect(await store.lookupTerminal('operation-1', 'exact-request-1')).toEqual(receipt)
    expect(await store.readWorkingBytes()).toEqual(encode('manual and agent edits'))
  })

  it('checks expected revisions inside the document queue so concurrent distinct mutations cannot overwrite', async () => {
    const { store, request } = await fixture()
    const results = await Promise.allSettled([
      store.commitCheckpoint(request('first')),
      store.commitCheckpoint(request('stale second', { operationId: 'operation-2', requestFingerprint: 'exact-request-2' })),
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'REVISION_CONFLICT' } })
    expect(await store.readWorkingBytes()).toEqual(encode('first'))
    expect(await store.lookupTerminal('operation-2', 'exact-request-2')).toBeUndefined()
  })

  it.each([
    { payloadHash: '0'.repeat(64) }, { payloadByteLength: 1 },
    { documentEpoch: 'obsolete-epoch' }, { expectedSavedRevision: 0 }, { expectedWorkingRevision: 0 },
  ])('rejects invalid payload or baseline metadata without publishing a checkpoint: %j', async (overrides) => {
    const { store, request } = await fixture()
    await expect(store.commitCheckpoint(request('new contents', overrides))).rejects.toBeDefined()
    expect(await store.getStatus()).toMatchObject({ workingRevision: 1, head: null, dirty: false })
    expect(await store.readWorkingBytes()).toEqual(encode('saved original'))
    expect(await store.lookupTerminal('operation-1', 'exact-request-1')).toBeUndefined()
  })

  it('rejects oversized bytes and oversized result envelopes before recording success', async () => {
    const { store, request } = await fixture({ maxByteLength: 24, maxResultByteLength: 256 })
    await expect(store.commitCheckpoint(request('x'.repeat(25)))).rejects.toMatchObject({ code: 'WORKING_COPY_INVALID_CHECKPOINT' })
    await expect(store.commitCheckpoint(request('small', {
      result: { ok: true, summary: 'x'.repeat(257), warnings: [] },
    }))).rejects.toMatchObject({ code: 'WORKING_COPY_INVALID_CHECKPOINT' })
    expect((await store.getStatus()).head).toBeNull()
  })

  it('rejects failed or non-JSON/engine-shaped result envelopes', async () => {
    const { store, request } = await fixture()
    for (const result of [
      { ok: false, summary: 'Failed', warnings: [] },
      { ok: true, summary: 'Failed verification', warnings: [], verification: { passed: false, issues: [] } },
      { ok: true, summary: 'Engine', warnings: [], engine: { execute() {} } },
      { ok: true, summary: 'Invalid data', warnings: [], data: new Uint8Array([1, 2]) },
      { ok: true, summary: 'Non-JSON data', warnings: [], data: new Date() },
    ]) {
      await expect(store.commitCheckpoint(request('bytes', { result: result as unknown as CheckpointRequest['result'] })))
        .rejects.toMatchObject({ code: 'WORKING_COPY_INVALID_CHECKPOINT' })
    }
    expect((await store.getStatus()).head).toBeNull()
  })

  it('retains the old recoverable head when publishing the new manifest fails', async () => {
    const { store, config, request } = await fixture()
    const first = await store.commitCheckpoint(request('first'))
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('/manifest.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return actual.rename(source, destination)
    })
    await expect(store.commitCheckpoint(request('second', {
      operationId: 'operation-2', requestFingerprint: 'exact-request-2', expectedWorkingRevision: 2,
    }))).rejects.toMatchObject({ code: 'WORKING_COPY_PERSIST_FAILED' })
    const blobDirectory = join(await manifestPath(config.rootDirectory), '..', 'blobs')
    expect(await fs.readdir(blobDirectory)).toEqual([hash(encode('first'))])
    const reopened = await createWorkingCopyStore(config)
    expect(await reopened.readWorkingBytes()).toEqual(encode('first'))
    expect(await reopened.lookupTerminal('operation-1', 'exact-request-1')).toEqual(first)
    expect(await reopened.lookupTerminal('operation-2', 'exact-request-2')).toBeUndefined()
  })

  it.each(['rewrite', 'same-bytes-replacement'] as const)('reports external %s as conflict and preserves recovery evidence', async (change) => {
    const { store, config, authorizedPath, directory, request } = await fixture()
    await store.commitCheckpoint(request())
    const path = await manifestPath(config.rootDirectory)
    const manifestBefore = await fs.readFile(path)
    if (change === 'rewrite') await fs.writeFile(authorizedPath, 'external contents')
    else {
      const replacement = join(directory, 'replacement')
      await fs.writeFile(replacement, 'saved original')
      await fs.rename(replacement, authorizedPath)
    }
    const reopened = await createWorkingCopyStore(config)
    expect(await reopened.getStatus()).toMatchObject({ recoveryState: 'conflict', dirty: true })
    await expect(reopened.readWorkingBytes()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(reopened.lookupTerminal('operation-1', 'exact-request-1')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(reopened.commitCheckpoint(request('new', { expectedWorkingRevision: 2 })))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await fs.readFile(path)).toEqual(manifestBefore)
  })

  it.each(['blob', 'manifest'] as const)('refuses damaged %s without deleting evidence or replaying a success', async (damage) => {
    const { store, config, request } = await fixture()
    const receipt = await store.commitCheckpoint(request())
    const path = await manifestPath(config.rootDirectory)
    const target = damage === 'manifest' ? path : join(path, '..', 'blobs', receipt.blobHash)
    await fs.writeFile(target, 'damaged')
    await expect(createWorkingCopyStore(config)).rejects.toMatchObject({ code: 'WORKING_COPY_RECOVERY_INVALID' })
    expect(await fs.readFile(target, 'utf8')).toBe('damaged')
  })

  it('keys storage by authorized path even when document IDs and basenames match', async () => {
    const { store, config, directory, request } = await fixture()
    await store.commitCheckpoint(request())
    const otherDirectory = join(directory, 'other')
    await fs.mkdir(otherDirectory)
    const authorizedPath = join(otherDirectory, 'source.bin')
    await fs.writeFile(authorizedPath, 'different document')
    const other = await createWorkingCopyStore({ ...config, authorizedPath })
    expect((await other.getStatus()).head).toBeNull()
    expect(await other.readWorkingBytes()).toEqual(encode('different document'))
  })

  it('snapshots caller-owned bytes and result before enqueueing and returns detached receipts', async () => {
    const { store, request } = await fixture()
    const pending = request('immutable')
    const commit = store.commitCheckpoint(pending)
    pending.bytes.fill(0)
    pending.result.summary = 'mutated'
    const receipt = await commit
    receipt.result.summary = 'also mutated'
    expect(await store.readWorkingBytes()).toEqual(encode('immutable'))
    expect((await store.lookupTerminal('operation-1', 'exact-request-1'))?.result.summary).toBe('Applied one change')
  })

  it('serializes two live store instances for the same Host document', async () => {
    const { store, config, request } = await fixture()
    const other = await createWorkingCopyStore(config)
    const outcomes = await Promise.allSettled([
      store.commitCheckpoint(request('first')),
      other.commitCheckpoint(request('second', { operationId: 'operation-2', requestFingerprint: 'exact-request-2' })),
    ])
    expect(outcomes[0].status).toBe('fulfilled')
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'REVISION_CONFLICT' } })
    expect(await other.readWorkingBytes()).toEqual(encode('first'))
  })

  it.each(['.blob-', '.manifest-'])('retains old head when fsync of %s temporary bytes fails', async (stage) => {
    const { store, config, request } = await fixture()
    await store.commitCheckpoint(request('first'))
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (path, ...args) => {
      const handle = await actual.open(path, ...args)
      if (String(path).includes(stage)) handle.sync = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
      return handle
    })
    await expect(store.commitCheckpoint(request('second', {
      operationId: 'operation-2', requestFingerprint: 'exact-request-2', expectedWorkingRevision: 2,
    }))).rejects.toMatchObject({ code: 'WORKING_COPY_PERSIST_FAILED' })
    const reopened = await createWorkingCopyStore(config)
    expect(await reopened.readWorkingBytes()).toEqual(encode('first'))
    expect(await reopened.lookupTerminal('operation-2', 'exact-request-2')).toBeUndefined()
  })

  it('reports unknown outcome after manifest publication and recovers its exact receipt on retry', async () => {
    const { store, config, request } = await fixture()
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    const path = await manifestPath(config.rootDirectory)
    const documentDirectory = await fs.realpath(join(path, '..'))
    vi.mocked(fs.open).mockImplementation(async (path, ...args) => {
      const handle = await actual.open(path, ...args)
      if (String(path) === documentDirectory) handle.sync = async () => { throw new Error('directory fsync failed') }
      return handle
    })
    await expect(store.commitCheckpoint(request())).rejects.toMatchObject({ code: 'WORKING_COPY_OUTCOME_UNKNOWN' })
    const unresolved = await Promise.allSettled([
      store.lookupTerminal('operation-1', 'exact-request-1'), store.commitCheckpoint(request()),
    ])
    expect(unresolved).toMatchObject([
      { status: 'rejected', reason: { code: 'WORKING_COPY_OUTCOME_UNKNOWN' } },
      { status: 'rejected', reason: { code: 'WORKING_COPY_OUTCOME_UNKNOWN' } },
    ])
    vi.mocked(fs.open).mockImplementation(actual.open)
    const reopened = await createWorkingCopyStore(config)
    const receipt = await reopened.lookupTerminal('operation-1', 'exact-request-1')
    expect(receipt).toMatchObject({ workingRevision: 2, result: { ok: true } })
    expect(await reopened.commitCheckpoint(request())).toEqual(receipt)
    expect(await reopened.readWorkingBytes()).toEqual(encode('manual and agent edits'))
  })

  it('preserves orphaned blobs when the manifest is missing instead of creating a fresh empty document', async () => {
    const { store, config, request } = await fixture()
    const receipt = await store.commitCheckpoint(request())
    const path = await manifestPath(config.rootDirectory)
    await fs.unlink(path)
    await expect(createWorkingCopyStore(config)).rejects.toMatchObject({ code: 'WORKING_COPY_RECOVERY_INVALID' })
    expect(await fs.readFile(join(path, '..', 'blobs', receipt.blobHash))).toEqual(Buffer.from('manual and agent edits'))
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects ledger capacity before publishing any blobs for successive distinct payloads', async () => {
    const { store, config, request } = await fixture({ maxManifestByteLength: 2048 })
    const first = await store.commitCheckpoint(request('first'))
    const path = await manifestPath(config.rootDirectory)
    const blobDirectory = join(path, '..', 'blobs')
    const before = await fs.readFile(path)
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (path, ...args) => {
      if (String(path).includes('/.blob-')) throw new Error('Blob allocation must not precede the capacity check')
      return actual.open(path, ...args)
    })
    for (const suffix of ['second', 'third']) {
      await expect(store.commitCheckpoint(request(suffix, {
        operationId: `operation-${suffix}`, requestFingerprint: `exact-request-${suffix}`, expectedWorkingRevision: 2,
        result: { ok: true, summary: 'x'.repeat(1800), warnings: [] },
      }))).rejects.toMatchObject({ code: 'WORKING_COPY_INVALID_CHECKPOINT' })
      expect(await fs.readdir(blobDirectory)).toEqual([first.blobHash])
      expect(await fs.readFile(path)).toEqual(before)
    }
    expect(await store.readWorkingBytes()).toEqual(encode('first'))
  })

  it('preserves an existing shared blob when a new manifest fails to publish', async () => {
    const { store, config, request } = await fixture()
    const first = await store.commitCheckpoint(request('shared bytes'))
    vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    await expect(store.commitCheckpoint(request('shared bytes', {
      operationId: 'operation-2', requestFingerprint: 'exact-request-2', expectedWorkingRevision: 2,
    }))).rejects.toMatchObject({ code: 'WORKING_COPY_PERSIST_FAILED' })
    const reopened = await createWorkingCopyStore(config)
    expect(await reopened.readWorkingBytes()).toEqual(encode('shared bytes'))
    expect(await reopened.lookupTerminal('operation-1', 'exact-request-1')).toEqual(first)
  })
})
