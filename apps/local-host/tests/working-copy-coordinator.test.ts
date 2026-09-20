import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { CheckpointMetadata, EditorRequestFrame, EditorRegisterFrame } from '@nexusdesk/protocol'
import { createWorkingCopyStore } from '../src/working-copy-store'
import { DocumentDriverRegistry, type LocalDocumentDriver } from '../src/document-driver'
import { DocumentRegistry } from '../src/document-registry'
import { AgentRouter } from '../src/agent-router'
import { OperationStore } from '../src/operation-store'
import { HarnessSupervisor } from '../src/harness-supervisor'

const dirs: string[] = []
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})
afterEach(async () => {
  vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof fs>('node:fs/promises')).open)
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const bytes = (text: string) => new TextEncoder().encode(text)
const result = { ok: true, summary: 'Applied', warnings: [] }
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

export async function fixture() {
  const module = await import('../src/working-copy-coordinator').catch(() => ({} as typeof import('../src/working-copy-coordinator')))
  expect(typeof module.WorkingCopyCoordinator).toBe('function')
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-test-')); dirs.push(dir)
  const authorizedPath = join(dir, 'document.docx')
  await writeFile(authorizedPath, 'original')
  const config = { rootDirectory: join(dir, 'recovery'), authorizedPath, documentId: 'doc', editorType: 'docs' as const }
  const store = await createWorkingCopyStore(config)
  let materializations = 0
  const driver: LocalDocumentDriver = {
    document: { documentId: 'doc', title: 'Test', editorType: 'docs', revision: 1 },
    bootstrap: async () => ({}), execute: async () => ({}), close: async () => {},
    workingCopy: { store, acquireSource: () => store.acquireSource(), readSource: (id) => store.readSource(id),
      materialize: async ({ parts }) => { materializations++; return parts.get('document')! } },
  }
  const documents = new DocumentRegistry([driver.document])
  const coordinator = new module.WorkingCopyCoordinator({ drivers: new DocumentDriverRegistry([driver]), documents,
    uploadRoot: join(dir, 'uploads') })
  const bootstrap = await coordinator.bootstrap('doc', 'http://localhost', 'http-session')
  const registration = { type: 'editor:register', protocolVersion: 1, id: 'register', clientId: 'client',
    rendererInstanceId: 'renderer', documentId: 'doc', editorType: 'docs', revision: 1,
    documentEpoch: bootstrap.documentEpoch, sourceContentId: bootstrap.sourceContentId,
    restoredCheckpointId: null } as EditorRegisterFrame
  await coordinator.register(registration, 'http-session')
  const frame = { type: 'editor:request', protocolVersion: 1, id: 'request',
    target: { documentId: 'doc', editorType: 'docs', clientId: 'client', sessionId: 'turn', operationId: 'op', revision: 1 },
    command: 'apply_ops', arguments: { operationId: 'op' }, approval: { id: 'approval', planHash: 'approved' },
  } as unknown as EditorRequestFrame
  const metadata = (f = frame): CheckpointMetadata => ({ schemaVersion: 1, requestId: f.id, clientId: f.target.clientId,
    operationId: f.target.operationId, documentEpoch: bootstrap.documentEpoch, sourceContentId: bootstrap.sourceContentId,
    expectedWorkingRevision: f.target.revision, expectedSavedRevision: 1, planHash: f.approval!.planHash,
    payloadKind: 'docx-bytes', result })
  return { dir, config, driver, documents, coordinator, store, bootstrap, registration, frame, metadata, authorizedPath,
    materializations: () => materializations, Coordinator: module.WorkingCopyCoordinator }
}
async function upload(setup: Awaited<ReturnType<typeof fixture>>, text = 'edited', frame = setup.frame) {
  await setup.coordinator.reserve(frame)
  const created = await setup.coordinator.beginUpload('doc', 'client', setup.metadata(frame))
  const part = await setup.coordinator.putPart('doc', 'client', created.uploadId, 'document', [bytes(text)])
  return { ...created, parts: [part] }
}

async function routedFixture() {
  const s = await fixture()
  const supervisor = new HarnessSupervisor({ entry: fileURLToPath(new URL('./fixtures/fake-runtime.mjs', import.meta.url)) })
  const operations = new OperationStore()
  const results: import('@nexusdesk/runtime-host/protocol').RuntimeEditorResponseFrame[] = []
  const sent: Array<{ type: string }> = []
  vi.spyOn(supervisor, 'respondEditor').mockImplementation((frame) => { results.push(frame) })
  const router = new AgentRouter({ supervisor, documents: s.documents, operations, workingCopy: s.coordinator,
    sendToClient: (_client, frame) => sent.push(frame) })
  await supervisor.ready()
  await router.handleClientFrame({ type: 'agent:start', protocolVersion: 1, id: 'start' as never,
    sessionId: s.frame.target.sessionId, documentId: s.frame.target.documentId, prompt: 'hello' }, s.frame.target.clientId)
  await router.routeRuntimeFrame({ type: 'approval:request', protocolVersion: 1, id: s.frame.approval!.id,
    sessionId: s.frame.target.sessionId, toolName: 'apply_document_ops',
    proposal: { planHash: 'approved', operationId: 'op', title: 'Apply', summary: 'Change', targets: [] } as never })
  await router.handleClientFrame({ type: 'approval:response', protocolVersion: 1, id: s.frame.approval!.id, outcome: 'allowed-once' }, s.frame.target.clientId)
  await router.routeRuntimeFrame(s.frame)
  return { ...s, supervisor, operations, results, sent, router }
}

async function failManifestSync(s: Awaited<ReturnType<typeof fixture>>) {
  const directory = await fs.realpath(join(s.config.rootDirectory, (await fs.readdir(s.config.rootDirectory))[0]!))
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.open).mockImplementation(async (path, ...args) => {
    const handle = await actual.open(path, ...args)
    if (String(path) === directory) handle.sync = async () => { throw Object.assign(Error('fsync unavailable'), { code: 'ENOSPC' }) }
    return handle
  })
  return () => { vi.mocked(fs.open).mockImplementation(actual.open) }
}

it.each([false, true])('immediately returns an unknown runtime result for unverified renderer ok=%s without ending recovery', async (ok) => {
  const s = await routedFixture()
  try {
    const up = await s.coordinator.beginUpload('doc', 'client', s.metadata())
    const part = await s.coordinator.putPart('doc', 'client', up.uploadId, 'document', [bytes('edited')])
    await s.router.handleClientFrame({ type: 'editor:result', protocolVersion: 1, id: s.frame.id,
      target: s.frame.target, result: { ok, summary: 'Renderer could not verify persistence.', warnings: [] } }, s.frame.target.clientId)
    expect(s.results).toHaveLength(1)
    expect(s.results[0]).toMatchObject({ id: s.frame.id, currentRevision: 1, result: {
      ok: false, warnings: [{ code: 'WORKING_COPY_OUTCOME_UNKNOWN' }] } })
    expect(s.results[0]?.persistence).toBeUndefined()
    expect(s.operations.lookup('op' as never)?.state).toBe('reserved')
    expect(await s.store.lookupTerminal('op', up.requestFingerprint)).toBeUndefined()
    expect(await s.coordinator.lookup('doc', 'client', { documentEpoch: s.bootstrap.documentEpoch,
      operationId: 'op', requestFingerprint: up.requestFingerprint })).toEqual({ state: 'pending' })
    await expect(s.router.routeRuntimeFrame(s.frame)).rejects.toThrow('one-time approval')
    const committed = await s.coordinator.commitUpload('doc', 'client', up.uploadId, [part])
    await s.router.notifyWorkingCopyCommit('doc', 'op')
    expect(s.results.at(-1)).toMatchObject({ result, persistence: committed.persistence, currentRevision: 2 })
    expect(s.sent.filter((frame) => frame.type === 'editor:request')).toHaveLength(1)
    expect(s.materializations()).toBe(1)
  } finally { s.router.dispose(); await s.supervisor.shutdown() }
})

it('delivers the verified durable terminal when the renderer reports failure without its lost receipt', async () => {
  const s = await routedFixture()
  try {
    const up = await s.coordinator.beginUpload('doc', 'client', s.metadata())
    const part = await s.coordinator.putPart('doc', 'client', up.uploadId, 'document', [bytes('edited')])
    const committed = await s.coordinator.commitUpload('doc', 'client', up.uploadId, [part])
    await s.router.handleClientFrame({ type: 'editor:result', protocolVersion: 1, id: s.frame.id,
      target: s.frame.target, result: { ok: false, summary: 'Commit response lost.', warnings: [] } }, s.frame.target.clientId)
    expect(s.results).toHaveLength(1)
    expect(s.results[0]).toMatchObject({ result, persistence: committed.persistence, currentRevision: 2 })
    expect(s.operations.lookup('op' as never)?.state).toBe('committed')
    expect(s.materializations()).toBe(1)
  } finally { s.router.dispose(); await s.supervisor.shutdown() }
})

it.each(['missing receipt', 'different result'] as const)('delivers the authoritative committed terminal despite renderer %s', async (response) => {
  const s = await routedFixture()
  try {
    const up = await s.coordinator.beginUpload('doc', 'client', s.metadata())
    const part = await s.coordinator.putPart('doc', 'client', up.uploadId, 'document', [bytes('edited')])
    const committed = await s.coordinator.commitUpload('doc', 'client', up.uploadId, [part])
    const manifestPath = join(s.config.rootDirectory, (await fs.readdir(s.config.rootDirectory))[0]!, 'manifest.json')
    const manifest = await readFile(manifestPath, 'utf8')
    await s.router.handleClientFrame({ type: 'editor:result', protocolVersion: 1, id: s.frame.id, target: s.frame.target,
      result: response === 'different result' ? { ok: true, summary: 'Renderer supplied a different summary.', warnings: [] } : result,
      ...(response === 'different result' ? { persistence: committed.persistence } : {}),
    }, s.frame.target.clientId)
    expect(s.results).toHaveLength(1)
    expect(s.results[0]).toMatchObject({ result, persistence: committed.persistence, currentRevision: 2 })
    expect(s.operations.lookup('op' as never)).toMatchObject({ state: 'committed', result })
    expect(s.sent.filter((frame) => frame.type === 'recovery:required')).toHaveLength(0)
    // The consumed approval is not renewed: retrying this same request replays only its original terminal.
    await s.router.routeRuntimeFrame(s.frame)
    expect(s.results).toHaveLength(2)
    expect(s.results[1]).toMatchObject({ result, persistence: committed.persistence, currentRevision: 2 })
    expect(s.sent.filter((frame) => frame.type === 'editor:request')).toHaveLength(1)
    expect(s.materializations()).toBe(1)
    expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
    expect(await readFile(s.authorizedPath, 'utf8')).toBe('original')
  } finally { s.router.dispose(); await s.supervisor.shutdown() }
})

it('immediately resolves runtime uncertainty even while durable lookup cannot finish its fsync check', async () => {
  const s = await routedFixture()
  try {
    const up = await s.coordinator.beginUpload('doc', 'client', s.metadata())
    const part = await s.coordinator.putPart('doc', 'client', up.uploadId, 'document', [bytes('edited')])
    const restore = await failManifestSync(s)
    await expect(s.coordinator.commitUpload('doc', 'client', up.uploadId, [part])).rejects.toMatchObject({ code: 'WORKING_COPY_OUTCOME_UNKNOWN' })
    await s.router.handleClientFrame({ type: 'editor:result', protocolVersion: 1, id: s.frame.id,
      target: s.frame.target, result: { ok: false, summary: 'Persistence outcome unknown.', warnings: [] } }, s.frame.target.clientId)
    expect(s.results).toHaveLength(1)
    expect(s.results[0]).toMatchObject({ result: { ok: false, warnings: [{ code: 'WORKING_COPY_OUTCOME_UNKNOWN' }] } })
    expect(s.operations.lookup('op' as never)?.state).toBe('reserved')
    restore()
    await s.router.notifyWorkingCopyCommit('doc', 'op')
    expect(s.results.at(-1)).toMatchObject({ result, persistence: { operationId: 'op', dirty: true }, currentRevision: 2 })
    expect(s.sent.filter((frame) => frame.type === 'editor:request')).toHaveLength(1)
  } finally { s.router.dispose(); await s.supervisor.shutdown() }
})

it('requires a reservation and atomically commits bytes plus bound terminal, recoverable without the original coordinator', async () => {
  const s = await fixture()
  await expect(s.coordinator.beginUpload('doc', 'client', s.metadata())).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' })
  const up = await upload(s)
  expect(await s.store.lookupTerminal('op', up.requestFingerprint)).toBeUndefined()
  const terminal = await s.coordinator.commitUpload('doc', 'client', up.uploadId, up.parts)
  expect(terminal).toMatchObject({ result: { ok: true }, persistence: { dirty: true, workingRevision: 2, savedRevision: 1 } })
  expect(await readFile(s.authorizedPath, 'utf8')).toBe('original')
  const reopened = await createWorkingCopyStore(s.config)
  expect(await reopened.readWorkingBytes()).toEqual(bytes('edited'))
  expect(await reopened.lookupOperationBinding('op')).toMatchObject({ sourceContentId: digest('original'), command: 'apply_ops' })
  const freshDocuments = new DocumentRegistry([s.driver.document])
  const fresh = new s.Coordinator({ drivers: new DocumentDriverRegistry([{ ...s.driver, workingCopy: {
    ...s.driver.workingCopy!, store: reopened, acquireSource: () => reopened.acquireSource(), readSource: (id) => reopened.readSource(id),
  } }]), documents: freshDocuments, uploadRoot: join(s.dir, 'uploads-2') })
  const freshBootstrap = await fresh.bootstrap('doc', 'http://localhost', 'new-session')
  await fresh.register({ ...s.registration, clientId: 'fresh' as never, rendererInstanceId: 'fresh-renderer' as never,
    revision: freshBootstrap.workingRevision as never, sourceContentId: freshBootstrap.sourceContentId,
    restoredCheckpointId: freshBootstrap.checkpointId }, 'new-session')
  expect(await fresh.lookup('doc', 'fresh', { documentEpoch: s.bootstrap.documentEpoch, operationId: 'op', requestFingerprint: up.requestFingerprint })).toMatchObject({ state: 'committed', result })
  await expect(fresh.lookup('doc', 'fresh', { documentEpoch: s.bootstrap.documentEpoch, operationId: 'op', requestFingerprint: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'OPERATION_ID_COLLISION' })
  expect(s.materializations()).toBe(1)
})

it('keeps bootstrap content immutable while rejecting stale hydration and an upload from a replaced renderer', async () => {
  const s = await fixture()
  const up = await upload(s)
  const old = await s.coordinator.bootstrap('doc', 'http://localhost', 'http-session')
  await s.coordinator.commitUpload('doc', 'client', up.uploadId, up.parts)
  expect(await s.coordinator.readSource('doc', 'http-session', old.sourceContentId)).toEqual(bytes('original'))
  await s.coordinator.disconnect('client')
  await expect(s.coordinator.register({ ...s.registration, clientId: 'new-client' as never, rendererInstanceId: 'new-renderer' as never }, 'http-session')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const current = await s.coordinator.bootstrap('doc', 'http://localhost', 'http-session')
  await s.coordinator.register({ ...s.registration, clientId: 'new-client' as never, rendererInstanceId: 'new-renderer' as never,
    revision: current.workingRevision as never, sourceContentId: current.sourceContentId, restoredCheckpointId: current.checkpointId }, 'http-session')
  await expect(s.coordinator.putPart('doc', 'client', up.uploadId, 'document', [bytes('evil')])).rejects.toThrow()
  expect(await s.store.readWorkingBytes()).toEqual(bytes('edited'))
})

it('invalidates an uncommitted upload on owner turnover and refuses mutation promotion without PDF rewrite approval', async () => {
  const s = await fixture()
  const up = await upload(s)
  expect(typeof s.coordinator.detach).toBe('function')
  await s.coordinator.detach('doc', 'client')
  await s.coordinator.bootstrap('doc', 'http://localhost', 'http-session')
  await s.coordinator.register({ ...s.registration, clientId: 'fresh' as never, rendererInstanceId: 'fresh-renderer' as never }, 'http-session')
  await expect(s.coordinator.commitUpload('doc', 'fresh', up.uploadId, up.parts)).rejects.toMatchObject({ code: 'WORKING_COPY_STALE_OWNER' })
  expect(await s.store.lookupTerminal('op', up.requestFingerprint)).toBeUndefined()
  expect(await s.store.readWorkingBytes()).toEqual(bytes('original'))
  const fresh = { ...s.frame, target: { ...s.frame.target, clientId: 'fresh', operationId: 'rewrite' } } as EditorRequestFrame
  await expect(s.coordinator.reserve(fresh, { inPlaceRewrite: true })).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' })
})

it('does not reserve a request whose editor type differs from the hydrated document', async () => {
  const s = await fixture()
  await expect(s.coordinator.reserve({ ...s.frame, target: { ...s.frame.target, editorType: 'pdf' } })).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' })
})

it('keeps the live renderer source fixed across checkpoints and accepts its confirmed revision after reconnect', async () => {
  const s = await fixture()
  const up = await upload(s)
  // Another tab may bootstrap the same immutable bytes while this renderer is capturing.
  await s.coordinator.bootstrap('doc', 'http://localhost', 'http-session')
  const committed = await s.coordinator.commitUpload('doc', 'client', up.uploadId, up.parts)
  await s.coordinator.disconnect('client')
  await s.coordinator.register({ ...s.registration, clientId: 'reconnected' as never,
    revision: 2 as never, restoredCheckpointId: committed.persistence.checkpointId }, 'http-session')
  const request = { ...s.frame, id: 'request-2', target: { ...s.frame.target, clientId: 'reconnected',
    operationId: 'operation-2', revision: 2 }, arguments: { operationId: 'operation-2' } } as unknown as EditorRequestFrame
  await s.coordinator.reserve(request)
  const next = await s.coordinator.beginUpload('doc', 'reconnected', { ...s.metadata(request), clientId: 'reconnected' })
  const part = await s.coordinator.putPart('doc', 'reconnected', next.uploadId, 'document', [bytes('next edits')])
  await s.coordinator.commitUpload('doc', 'reconnected', next.uploadId, [part])
  expect(await s.store.lookupOperationBinding('operation-2')).toMatchObject({ sourceContentId: digest('original'), fromWorkingRevision: 2 })
})

it('uses authenticated manual-save uploads and directly promotes an unchanged recovered dirty checkpoint', async () => {
  const s = await fixture()
  const up = await upload(s)
  const checkpoint = await s.coordinator.commitUpload('doc', 'client', up.uploadId, up.parts)
  expect(typeof s.coordinator.beginManualUpload).toBe('function')
  const snapshotHash = digest(JSON.stringify([['document', digest('edited')]]))
  const manual = await s.coordinator.beginManualUpload('doc', 'client', {
    operationId: 'manual', documentEpoch: s.bootstrap.documentEpoch, sourceContentId: s.bootstrap.sourceContentId,
    expectedWorkingRevision: 2, expectedSavedRevision: 1, payloadKind: 'docx-bytes', snapshotHash })
  const part = await s.coordinator.putPart('doc', 'client', manual.uploadId, 'document', [bytes('edited')])
  const saved = await s.coordinator.commitUpload('doc', 'client', manual.uploadId, [part])
  expect(saved.persistence.operationId).toMatch(/^manual-[a-f0-9]{64}$/)
  expect(saved.persistence).toMatchObject({ checkpointId: checkpoint.persistence.checkpointId, dirty: false, workingRevision: 2, savedRevision: 2 })
  expect(await readFile(s.authorizedPath, 'utf8')).toBe('edited')
})

it('revokes uploads when the same renderer fully rebases onto a different source', async () => {
  const s = await fixture()
  const first = await upload(s)
  await s.coordinator.commitUpload('doc', 'client', first.uploadId, first.parts)
  const next = { ...s.frame, id: 'next', target: { ...s.frame.target, operationId: 'next', revision: 2 },
    arguments: { operationId: 'next' } } as unknown as EditorRequestFrame
  const pending = await upload(s, 'stale source edits', next)
  const boot = await s.coordinator.bootstrap('doc', 'http://localhost', 'http-session')
  await s.coordinator.register({ ...s.registration, revision: 2 as never, sourceContentId: boot.sourceContentId,
    restoredCheckpointId: boot.checkpointId }, 'http-session')
  await expect(s.coordinator.commitUpload('doc', 'client', pending.uploadId, pending.parts)).rejects.toMatchObject({ code: 'WORKING_COPY_STALE_OWNER' })
  expect(await s.store.readWorkingBytes()).toEqual(bytes('edited'))
})

it('releases definitively failed upload attempts after consulting the ledger so recovery can upload the frozen snapshot again', async () => {
  const s = await fixture()
  s.driver.workingCopy!.materialize = async () => { throw Object.assign(Error('Disk full'), { code: 'WORKING_COPY_PERSIST_FAILED' }) }
  await s.coordinator.reserve(s.frame)
  for (let attempt = 0; attempt < 3; attempt++) {
    const up = await s.coordinator.beginUpload('doc', 'client', s.metadata())
    const part = await s.coordinator.putPart('doc', 'client', up.uploadId, 'document', [bytes('edited')])
    await expect(s.coordinator.commitUpload('doc', 'client', up.uploadId, [part])).rejects.toMatchObject({ code: 'WORKING_COPY_PERSIST_FAILED' })
    expect(await s.store.lookupTerminal('op', up.requestFingerprint)).toBeUndefined()
  }
  expect(await s.store.readWorkingBytes()).toEqual(bytes('original'))
})

it('reclaims sealed uploads only after unknown outcomes are verified committed so later uploads remain available', async () => {
  const s = await fixture()
  for (let attempt = 0; attempt < 2; attempt++) {
    const frame = { ...s.frame, id: 'unknown-' + attempt, target: { ...s.frame.target,
      operationId: 'unknown-' + attempt, revision: attempt + 1 }, arguments: { operationId: 'unknown-' + attempt } } as unknown as EditorRequestFrame
    const up = await upload(s, 'edited-' + attempt, frame)
    const restore = await failManifestSync(s)
    await expect(s.coordinator.commitUpload('doc', 'client', up.uploadId, up.parts)).rejects.toMatchObject({ code: 'WORKING_COPY_OUTCOME_UNKNOWN' })
    await expect(s.coordinator.lookup('doc', 'client', { documentEpoch: s.bootstrap.documentEpoch,
      operationId: frame.target.operationId, requestFingerprint: up.requestFingerprint })).rejects.toMatchObject({ code: 'WORKING_COPY_OUTCOME_UNKNOWN' })
    expect((await fs.readdir(join(s.dir, 'uploads'))).length).toBeGreaterThan(0)
    restore()
    const terminal = await s.coordinator.lookup('doc', 'client', { documentEpoch: s.bootstrap.documentEpoch,
      operationId: frame.target.operationId, requestFingerprint: up.requestFingerprint })
    expect(terminal.state).toBe('committed')
    expect(await s.coordinator.commitUpload('doc', 'client', up.uploadId, up.parts)).toMatchObject(terminal.state === 'committed'
      ? { persistence: terminal.persistence, result: terminal.result } : {})
    await s.coordinator.bootstrap('doc', 'http://localhost', 'http-session')
  }
  const next = { ...s.frame, id: 'next', target: { ...s.frame.target, operationId: 'next', revision: 3 },
    arguments: { operationId: 'next' } } as unknown as EditorRequestFrame
  const up = await upload(s, 'next edits', next)
  expect(await s.coordinator.commitUpload('doc', 'client', up.uploadId, up.parts)).toMatchObject({ persistence: { workingRevision: 4 } })
  expect(s.materializations()).toBe(3)
})

it('reclaims unsealed uploads when replaying a committed operation and retains their receipt aliases', async () => {
  const s = await fixture()
  const first = await upload(s)
  const committed = await s.coordinator.commitUpload('doc', 'client', first.uploadId, first.parts)
  const replayIds: string[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const replay = await s.coordinator.beginUpload('doc', 'client', s.metadata())
    replayIds.push(replay.uploadId)
    expect(await s.coordinator.commitUpload('doc', 'client', replay.uploadId, [])).toEqual(committed)
  }
  for (const uploadId of replayIds) expect(await s.coordinator.commitUpload('doc', 'client', uploadId, [])).toEqual(committed)
  expect(await fs.readdir(join(s.dir, 'uploads'))).toEqual([])
  expect(s.materializations()).toBe(1)
})

it('reclaims every upload of the verified operation but preserves an unrelated pending operation', async () => {
  const s = await fixture()
  const first = await upload(s)
  const duplicate = await s.coordinator.beginUpload('doc', 'client', s.metadata())
  const committed = await s.coordinator.commitUpload('doc', 'client', first.uploadId, first.parts)
  const other = { ...s.frame, id: 'other', target: { ...s.frame.target, operationId: 'other', revision: 2 },
    arguments: { operationId: 'other' } } as unknown as EditorRequestFrame
  const pending = await upload(s, 'pending', other)
  expect(await s.coordinator.lookup('doc', 'client', { documentEpoch: s.bootstrap.documentEpoch,
    operationId: 'op', requestFingerprint: first.requestFingerprint })).toMatchObject({ state: 'committed' })
  expect(await s.coordinator.commitUpload('doc', 'client', duplicate.uploadId, [])).toEqual(committed)
  expect(await fs.readdir(join(s.dir, 'uploads'))).toHaveLength(1)
  expect(await s.coordinator.commitUpload('doc', 'client', pending.uploadId, pending.parts)).toMatchObject({ persistence: { workingRevision: 3 } })
})

it.each(['ENOSPC', 'unknown-fsync'] as const)('preserves Store evidence through coordinator %s and never invents a failed terminal', async (failure) => {
  const s = await fixture()
  const up = await upload(s)
  const documentDirectory = await fs.realpath(join(s.config.rootDirectory, (await fs.readdir(s.config.rootDirectory))[0]!))
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.open).mockImplementation(async (path, ...args) => {
    const handle = await actual.open(path, ...args)
    if ((failure === 'ENOSPC' && String(path).includes('/.blob-')) ||
        (failure === 'unknown-fsync' && String(path) === documentDirectory)) {
      handle.sync = async () => { throw Object.assign(Error(failure), { code: 'ENOSPC' }) }
    }
    return handle
  })
  await expect(s.coordinator.commitUpload('doc', 'client', up.uploadId, up.parts)).rejects.toMatchObject({
    code: failure === 'ENOSPC' ? 'WORKING_COPY_PERSIST_FAILED' : 'WORKING_COPY_OUTCOME_UNKNOWN' })
  expect(await readFile(s.authorizedPath, 'utf8')).toBe('original')
  vi.mocked(fs.open).mockImplementation(actual.open)
  const terminal = await s.coordinator.lookup('doc', 'client', { documentEpoch: s.bootstrap.documentEpoch,
    operationId: 'op', requestFingerprint: up.requestFingerprint })
  expect(terminal.state).toBe(failure === 'ENOSPC' ? 'pending' : 'committed')
  expect(await s.store.readWorkingBytes()).toEqual(bytes(failure === 'ENOSPC' ? 'original' : 'edited'))
  expect(await s.store.readSource(s.bootstrap.sourceContentId)).toEqual(bytes('original'))
})

it('prepares new manual and Agent save snapshots under an internal identity, then replays without materializing twice', async () => {
  const s = await fixture()
  const up = await upload(s)
  await s.coordinator.commitUpload('doc', 'client', up.uploadId, up.parts)
  const save = { ...s.frame, id: 'save-request', target: { ...s.frame.target, operationId: 'save', revision: 2 },
    command: 'save_document', approval: { id: 'save-approval', planHash: 'save-plan' } } as EditorRequestFrame
  const saved = await upload(s, 'manual after apply', save)
  const terminal = await s.coordinator.commitUpload('doc', 'client', saved.uploadId, saved.parts)
  expect(terminal.persistence).toMatchObject({ dirty: false, workingRevision: 3, savedRevision: 2 })
  expect(await readFile(s.authorizedPath, 'utf8')).toBe('manual after apply')
  expect(await s.coordinator.commitUpload('doc', 'client', saved.uploadId, saved.parts)).toEqual(terminal)
  expect(s.materializations()).toBe(2)
  const manual = await s.coordinator.saveManual({ documentId: 'doc', clientId: 'client', operationId: 'manual-save',
    documentEpoch: s.bootstrap.documentEpoch, sourceContentId: s.bootstrap.sourceContentId,
    expectedWorkingRevision: 3, expectedSavedRevision: 2, payloadKind: 'docx-bytes', parts: new Map([['document', bytes('manual only')]]) })
  expect(manual.persistence).toMatchObject({ dirty: false, savedRevision: 3, workingRevision: 4 })
  expect(await readFile(s.authorizedPath, 'utf8')).toBe('manual only')
  expect(await s.store.readSource(s.bootstrap.sourceContentId)).toEqual(bytes('original'))
})

it('rejects renderer-only success and replays a durable result after delivery loss without executing again', async () => {
  const s = await fixture()
  const supervisor = new HarnessSupervisor({ entry: fileURLToPath(new URL('./fixtures/fake-runtime.mjs', import.meta.url)) })
  const operations = new OperationStore()
  const sent: Array<{ type: string }> = []
  const results: Array<{ result: { ok: boolean }; persistence?: unknown; currentRevision: number }> = []
  const respond = vi.spyOn(supervisor, 'respondEditor').mockImplementation((frame) => { results.push(frame) })
  const router = new AgentRouter({ supervisor, documents: s.documents, operations, workingCopy: s.coordinator,
    sendToClient: (_client, frame) => sent.push(frame) })
  try {
    await supervisor.ready()
    await router.handleClientFrame({ type: 'agent:start', protocolVersion: 1, id: 'start' as never,
      sessionId: s.frame.target.sessionId, documentId: s.frame.target.documentId, prompt: 'hello' }, s.frame.target.clientId)
    await router.routeRuntimeFrame({ type: 'approval:request', protocolVersion: 1, id: s.frame.approval!.id,
      sessionId: s.frame.target.sessionId, toolName: 'apply_document_ops',
      proposal: { planHash: 'approved', operationId: 'op', title: 'Apply', summary: 'Change', targets: [] } as never })
    await router.handleClientFrame({ type: 'approval:response', protocolVersion: 1, id: s.frame.approval!.id, outcome: 'allowed-once' }, s.frame.target.clientId)
    await router.routeRuntimeFrame(s.frame)
    await router.handleClientFrame({ type: 'editor:result', protocolVersion: 1, id: s.frame.id, target: s.frame.target, result }, s.frame.target.clientId)
    expect(results.some((frame) => frame.result.ok)).toBe(false)
    expect(operations.lookup('op' as never)?.state).not.toBe('committed')
    const up = await s.coordinator.beginUpload('doc', 'client', s.metadata())
    const part = await s.coordinator.putPart('doc', 'client', up.uploadId, 'document', [bytes('edited')])
    const committed = await s.coordinator.commitUpload('doc', 'client', up.uploadId, [part])
    expect(typeof router.notifyWorkingCopyCommit).toBe('function')
    respond.mockImplementationOnce(() => { throw Error('transport disconnected after durable commit') })
    await router.notifyWorkingCopyCommit('doc', 'op').catch(() => undefined)
    await s.coordinator.disconnect('client')
    const boot = await s.coordinator.bootstrap('doc', 'http://localhost', 'http-session')
    const registered = { ...s.registration, clientId: 'fresh' as never, rendererInstanceId: 'fresh-renderer' as never,
      revision: boot.workingRevision as never, sourceContentId: boot.sourceContentId, restoredCheckpointId: boot.checkpointId }
    await s.coordinator.register(registered, 'http-session')
    await router.handleClientFrame(registered, registered.clientId)
    expect(results.filter((frame) => frame.result.ok)).toHaveLength(1)
    expect(results.at(-1)).toMatchObject({ persistence: committed.persistence, currentRevision: 2 })
    expect(sent.filter((frame) => frame.type === 'editor:request')).toHaveLength(1)
    expect(s.materializations()).toBe(1)
    await router.handleClientFrame({ type: 'operation:lookup', protocolVersion: 1, id: 'lookup' as never,
      documentId: 'doc' as never, documentEpoch: boot.documentEpoch, operationId: 'op' as never,
      requestFingerprint: up.requestFingerprint }, registered.clientId)
    expect(sent.at(-1)).toMatchObject({ type: 'operation:result', state: 'committed', persistence: committed.persistence })
    expect(typeof router.handleRuntimeFrame).toBe('function')
    respond.mockImplementationOnce(() => { throw Error('runtime transport is also gone') })
    await expect(router.handleRuntimeFrame({ ...s.frame, target: { ...s.frame.target, sessionId: 'missing' as never } })).resolves.toBeUndefined()
  } finally { router.dispose(); await supervisor.shutdown() }
})
