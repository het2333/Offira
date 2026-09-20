import { expect, it, vi } from 'vitest'
import { BoundedEditorCache, createEditorResultJournal } from '../src/editor-result-journal'

const record = { fingerprint: 'request', result: { ok: true, summary: 'saved', warnings: [] } }

function storageFixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key)
    }),
  }
  return { values, storage }
}

it('bounds proposal caches and refreshes access order', () => {
  const cache = new BoundedEditorCache<number, number>()
  for (let i = 0; i < 128; i++) cache.set(i, i)
  expect(cache.get(0)).toBe(0)
  cache.set(128, 128)
  expect(cache.size).toBe(128)
  expect(cache.has(0)).toBe(true)
  expect(cache.has(1)).toBe(false)
})

it.each(['getItem', 'setItem', 'removeItem'] as const)(
  'keeps memory replay and bounded persistent entries when storage.%s fails',
  (method) => {
    const { values, storage } = storageFixture()
    const journal = createEditorResultJournal(storage, 'doc')
    for (let i = 0; i < 128; i++) journal.write(String(i), record)
    storage[method].mockImplementation(() => {
      throw Error('storage denied')
    })
    for (let i = 128; i < 300; i++) journal.write(String(i), record)
    expect(journal.read('299')).toEqual(record)
    expect(values.size).toBeLessThanOrEqual(129)
  },
)

it('bounds record size in bytes and does not retain oversized results in memory', () => {
  const { values, storage } = storageFixture()
  const journal = createEditorResultJournal(storage, 'doc')
  journal.write('big', { ...record, result: { ...record.result, summary: '中'.repeat(30_000) } })
  expect(values.size).toBe(0)
  expect(journal.read('big')).toBeUndefined()
})

it('does not add unindexed persistent entries when the index is malformed', () => {
  const { values, storage } = storageFixture()
  values.set('nexusdesk:editor-result-index:doc', '{broken')
  const journal = createEditorResultJournal(storage, 'doc')
  journal.write('operation', record)
  expect(values.size).toBe(1)
  expect(journal.read('operation')).toEqual(record)
})
