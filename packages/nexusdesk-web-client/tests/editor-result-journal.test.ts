import { expect, it, vi } from 'vitest'
import { BoundedEditorCache, createEditorResultJournal } from '../src/editor-result-journal'

const record = { fingerprint: 'request', result: { ok: true, summary: 'saved', warnings: [] } }

it('automatically releases abandoned proposal snapshots at the fixed TTL', () => {
  vi.useFakeTimers()
  try {
    const cache = new BoundedEditorCache<string, unknown>()
    cache.set('rejected-or-cancelled', { snapshot: 'x'.repeat(70 * 1024) })
    vi.advanceTimersByTime(120_001)
    expect(cache.size).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('expires both memory receipts and persistent keys without another request', () => {
  vi.useFakeTimers()
  try {
    const { values, storage } = storageFixture()
    const journal = createEditorResultJournal(storage, 'ttl-doc')
    journal.write('op', record)
    expect(journal.read('op')).toEqual(record)
    vi.advanceTimersByTime(600_001)
    expect(values.size).toBe(0)
    expect(journal.read('op')).toBeUndefined()
    journal.clearMemory()
  } finally {
    vi.useRealTimers()
  }
})

it('enforces a 512 KiB per-document total byte cap in storage and memory', () => {
  const { values, storage } = storageFixture()
  const journal = createEditorResultJournal(storage, 'byte-doc')
  const large = { ...record, result: { ...record.result, summary: 'x'.repeat(40 * 1024) } }
  for (let index = 0; index < 30; index++) journal.write(String(index), large)
  const storedBytes = [...values].reduce(
    (total, [key, value]) => total + new TextEncoder().encode(key + value).byteLength,
    0,
  )
  expect(storedBytes).toBeLessThanOrEqual(512 * 1024)
  expect(journal.read('0')).toBeUndefined()
  expect(journal.read('29')).toEqual(large)
  journal.clearMemory()
})

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
  cache.clear()
})

it('bounds the total retained proposal snapshot bytes before the count limit', () => {
  const cache = new BoundedEditorCache<string, unknown>()
  for (let index = 0; index < 3; index++)
    cache.set(String(index), { snapshot: 'x'.repeat(3 * 1024 * 1024) })
  expect(cache.size).toBe(2)
  expect(cache.has('0')).toBe(false)
  expect(() => cache.set('oversized', { snapshot: 'x'.repeat(9 * 1024 * 1024) })).toThrow(
    /byte limit/,
  )
  cache.clear()
})

it('does not renew the receipt TTL on reads or reloads', () => {
  vi.useFakeTimers()
  try {
    const { values, storage } = storageFixture()
    const journal = createEditorResultJournal(storage, 'absolute-ttl')
    journal.write('op', record)
    vi.advanceTimersByTime(599_999)
    expect(journal.read('op')).toEqual(record)
    vi.advanceTimersByTime(2)
    expect(values.size).toBe(0)
    journal.clearMemory()
    const reloaded = createEditorResultJournal(storage, 'absolute-ttl')
    expect(reloaded.read('op')).toBeUndefined()
    reloaded.clearMemory()
  } finally {
    vi.useRealTimers()
  }
})

it('cleans expired persistent receipts when a disposed bridge is reopened', () => {
  vi.useFakeTimers()
  try {
    const { values, storage } = storageFixture()
    const journal = createEditorResultJournal(storage, 'reopen')
    journal.write('op', record)
    journal.clearMemory()
    vi.advanceTimersByTime(600_001)
    const reloaded = createEditorResultJournal(storage, 'reopen')
    expect(values.size).toBe(0)
    expect(reloaded.read('op')).toBeUndefined()
    reloaded.clearMemory()
  } finally {
    vi.useRealTimers()
  }
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

it('keeps late terminal writes durable after disposal, then removes expired persistent bytes', () => {
  vi.useFakeTimers()
  try {
    const { values, storage } = storageFixture()
    const journal = createEditorResultJournal(storage, 'late-write')
    journal.clearMemory()
    journal.write('op', record)
    const reloaded = createEditorResultJournal(storage, 'late-write')
    expect(reloaded.read('op')).toEqual(record)
    reloaded.clearMemory()
    vi.advanceTimersByTime(600_001)
    expect(values.size).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('does not add unindexed persistent entries when the index is malformed', () => {
  const { values, storage } = storageFixture()
  values.set('nexusdesk:editor-result-index:doc', '{broken')
  const journal = createEditorResultJournal(storage, 'doc')
  journal.write('operation', record)
  expect(values.size).toBe(1)
  expect(journal.read('operation')).toEqual(record)
})
