import { expect, it } from 'vitest'
import type { EditorRequestFrame, WorkingCopyBootstrap } from '@nexusdesk/protocol'
import { createEditorResultJournal } from '../src/editor-result-journal'
import { editorRequestFingerprint } from '../src/editor-result-journal'

const bootstrap: WorkingCopyBootstrap = { documentEpoch: 'epoch', sourceContentId: 'a'.repeat(64), checkpointId: null,
  workingRevision: 1, savedRevision: 1, dirty: false, recoveryState: 'ready', contentUrl: '/source' }
const frame = { type: 'editor:request', protocolVersion: 1, id: 'request', command: 'apply_ops', arguments: {},
  target: { documentId: 'doc', editorType: 'docs', clientId: 'client', operationId: 'op', revision: 1, sessionId: 'turn' },
  approval: { id: 'approval', planHash: 'plan' } } as unknown as EditorRequestFrame
const result = { ok: true, summary: 'Applied', warnings: [] }
const persistence = { documentEpoch: 'epoch', operationId: 'op', requestFingerprint: 'b'.repeat(64),
  checkpointId: 'checkpoint', blobHash: 'c'.repeat(64), workingRevision: 2, savedRevision: 1, dirty: true }

it('uploads raw binary and resolves a lost commit acknowledgement through exact lookup without resubmission', async () => {
  const module = await import('../src/working-copy').catch(() => ({} as typeof import('../src/working-copy')))
  expect(typeof module.createBrowserWorkingCopyPersistence).toBe('function')
  const requests: Array<{ url: string; body: unknown }> = []
  const helper = module.createBrowserWorkingCopyPersistence({ documentId: 'doc', origin: 'http://host',
    state: () => bootstrap, clientId: () => 'client', fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body })
      if (String(url).endsWith('/checkpoint-uploads')) return Response.json({ uploadId: 'upload', requestFingerprint: 'b'.repeat(64) })
      if (String(url).includes('/parts/')) {
        expect(init?.body).toBeInstanceOf(Blob)
        expect(await (init!.body as Blob).text()).toBe('complete bytes')
        return Response.json({ partId: 'document', sha256: 'c'.repeat(64), byteLength: 14 })
      }
      if (String(url).endsWith('/commit')) throw Error('ack lost')
      expect(JSON.parse(init!.body as string)).toEqual({ documentEpoch: 'epoch', operationId: 'op', requestFingerprint: 'b'.repeat(64) })
      return Response.json({ state: 'committed', result, persistence })
    } })
  expect(await helper.checkpoint(frame, result, { kind: 'docx-bytes', parts: new Map([['document', new Blob(['complete bytes'])]]) })).toEqual(persistence)
  expect(requests.filter((request) => request.url.endsWith('/commit'))).toHaveLength(1)
  expect(requests.filter((request) => request.url.endsWith('/checkpoint-uploads'))).toHaveLength(1)
})

it('does not replay legacy ok journals as durable receipts when persistence is required', () => {
  const journal = createEditorResultJournal(undefined, 'doc', { requirePersistence: true })
  journal.write('op', { fingerprint: 'b'.repeat(64), result })
  expect(journal.read('op')).toBeUndefined()
  journal.write('op', { fingerprint: 'b'.repeat(64), result, persistence })
  expect(journal.read('op')).toMatchObject({ result, persistence })
  journal.clearMemory()
})

it('serializes mutation, capture and explicit save through one shared lane', async () => {
  const module = await import('../src/working-copy')
  expect(typeof module.createWorkingCopyMutationLane).toBe('function')
  const lane = module.createWorkingCopyMutationLane()
  const events: string[] = []
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  const mutation = lane.run(async () => { events.push('mutate'); await wait; events.push('capture') })
  const save = lane.run(async () => { events.push('save') })
  await Promise.resolve()
  expect(events).toEqual(['mutate'])
  release(); await Promise.all([mutation, save])
  expect(events).toEqual(['mutate', 'capture', 'save'])
})

it('creates a separate authenticated manual save intent for toolbar saves', async () => {
  const module = await import('../src/working-copy')
  const paths: string[] = []
  const helper = module.createBrowserWorkingCopyPersistence({ documentId: 'doc', origin: 'http://host',
    state: () => bootstrap, clientId: () => 'client', fetch: async (url) => {
      paths.push(String(url))
      if (String(url).endsWith('/manual-save-uploads')) return Response.json({ uploadId: 'manual-upload', operationId: 'host-manual', requestFingerprint: 'b'.repeat(64) })
      if (String(url).includes('/parts/')) return Response.json({ partId: 'document', sha256: 'c'.repeat(64), byteLength: 5 })
      return Response.json({ persistence: { ...persistence, operationId: 'host-manual', dirty: false }, result })
    } })
  expect(typeof helper.saveManual).toBe('function')
  expect(await helper.saveManual('op', { kind: 'docx-bytes', parts: new Map([['document', new Blob(['saved'])]]) })).toMatchObject({ dirty: false })
  expect(paths[0]).toBe('http://host/api/documents/doc/manual-save-uploads')
})

it('rejects a committed lookup receipt for another operation instead of claiming this mutation succeeded', async () => {
  const module = await import('../src/working-copy')
  const helper = module.createBrowserWorkingCopyPersistence({ documentId: 'doc', origin: 'http://host',
    state: () => bootstrap, clientId: () => 'client',
    fetch: async () => Response.json({ state: 'committed', persistence: { ...persistence, operationId: 'other' }, result }) })
  await expect(helper.lookup('op', 'b'.repeat(64))).rejects.toMatchObject({ code: 'WORKING_COPY_RECOVERY_INVALID' })
})

it('includes the document epoch in durable browser fingerprints while ignoring request and client identity', async () => {
  const a = await editorRequestFingerprint(frame, 'epoch-1')
  expect(await editorRequestFingerprint({ ...frame, id: 'another' as never,
    target: { ...frame.target, clientId: 'another' as never, revision: 8 as never } }, 'epoch-1')).toBe(a)
  expect(await editorRequestFingerprint(frame, 'epoch-2')).not.toBe(a)
})

it('preserves an uncertain applied state when upload creation itself loses its response', async () => {
  const module = await import('../src/working-copy')
  const helper = module.createBrowserWorkingCopyPersistence({ documentId: 'doc', origin: 'http://host',
    state: () => bootstrap, clientId: () => 'client', fetch: async () => { throw Error('Connection lost') } })
  await expect(helper.checkpoint(frame, result, { kind: 'docx-bytes', parts: new Map([['document', new Blob(['edited'])]]) }))
    .rejects.toMatchObject({ code: 'WORKING_COPY_OUTCOME_UNKNOWN' })
})
