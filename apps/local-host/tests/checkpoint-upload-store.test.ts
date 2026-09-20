import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function fixture(options = {}) {
  const module = await import('../src/checkpoint-upload-store').catch(() => ({} as typeof import('../src/checkpoint-upload-store')))
  expect(typeof module.CheckpointUploadStore).toBe('function')
  const rootDirectory = await mkdtemp(join(tmpdir(), 'checkpoint-upload-test-'))
  directories.push(rootDirectory)
  return new module.CheckpointUploadStore({ rootDirectory, ...options })
}
const bytes = (text: string) => new TextEncoder().encode(text)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
async function* stream(text: string) { for (const chunk of text) yield bytes(chunk) }

it('stores binary streams and rejects a forged digest or unlisted extra part', async () => {
  const store = await fixture()
  const id = await store.create({ documentId: 'doc', operationId: 'op', lease: 'owner' })
  const part = await store.put(id, 'document', stream('binary'))
  expect(part).toEqual({ partId: 'document', sha256: digest('binary'), byteLength: 6 })
  await expect(store.readParts(id, [{ ...part, sha256: 'f'.repeat(64) }])).rejects.toMatchObject({ code: 'WORKING_COPY_INVALID_CHECKPOINT' })
  const parts = await store.readParts(id, [part])
  expect(parts.get('document')).toEqual(bytes('binary'))
  await store.discard(id)
  await expect(store.get(id)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' })
})

it('enforces actual stream size, aggregate size, part identifiers, upload capacity and expiry', async () => {
  let now = 0
  const store = await fixture({ maxByteLength: 8, maxUploads: 1, maxParts: 2, ttlMs: 10, now: () => now })
  const id = await store.create({ documentId: 'doc' })
  await expect(store.create({ documentId: 'doc' })).rejects.toMatchObject({ code: 'UPLOAD_LIMIT' })
  await expect(store.put(id, '../escape', stream('x'))).rejects.toMatchObject({ code: 'WORKING_COPY_INVALID_CHECKPOINT' })
  await expect(store.put(id, 'document', stream('123456789'))).rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' })
  await store.put(id, 'manifest', stream('12345'))
  await expect(store.put(id, 'edits-0000', stream('6789'))).rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' })
  now = 11
  await expect(store.get(id)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' })
  expect(await store.create({ documentId: 'doc' })).toEqual(expect.any(String))
})

it('limits uploads per document so one renderer cannot consume every active slot', async () => {
  const store = await fixture({ maxUploads: 4, maxUploadsPerGroup: 1, groupKey: (value: { documentId: string }) => value.documentId })
  await store.create({ documentId: 'first' })
  await expect(store.create({ documentId: 'first' })).rejects.toMatchObject({ code: 'UPLOAD_LIMIT' })
  expect(await store.create({ documentId: 'second' })).toEqual(expect.any(String))
})
