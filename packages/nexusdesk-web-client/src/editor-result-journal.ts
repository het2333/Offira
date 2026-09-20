import type { AgentToolResult, EditorRequestFrame } from '@nexusdesk/protocol'

export const EDITOR_JOURNAL_LIMIT = 128
export const EDITOR_JOURNAL_MAX_BYTES = 64 * 1024
export const EDITOR_JOURNAL_TOTAL_BYTES = 512 * 1024
export const EDITOR_JOURNAL_TTL_MS = 10 * 60 * 1000
export const EDITOR_PROPOSAL_TTL_MS = 2 * 60 * 1000
const PROPOSAL_TOTAL_BYTES = 8 * 1024 * 1024
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength
const unref = (timer: ReturnType<typeof setTimeout>): void => {
  ;(timer as unknown as { unref?(): void }).unref?.()
}

/** Absolute TTL, entry and serialized-byte bounds; expiry releases values even while idle. */
export class BoundedEditorCache<K, V> extends Map<K, V> {
  private readonly timers = new Map<K, ReturnType<typeof setTimeout>>()
  private readonly weights = new Map<K, number>()
  private bytes = 0

  override get(key: K): V | undefined {
    const value = super.get(key)
    if (value !== undefined) {
      super.delete(key)
      super.set(key, value)
    }
    return value
  }

  override set(key: K, value: V): this {
    this.delete(key)
    // Editor adapters are opaque handles, not retained serialized request data.
    const measured =
      value && typeof value === 'object' && 'adapter' in value
        ? { ...value, adapter: undefined }
        : value
    const bytes = byteLength(JSON.stringify(measured) ?? '')
    if (bytes > PROPOSAL_TOTAL_BYTES) throw Error('Editor proposal exceeds cache byte limit')
    while (this.size >= EDITOR_JOURNAL_LIMIT || this.bytes + bytes > PROPOSAL_TOTAL_BYTES) {
      this.delete(this.keys().next().value as K)
    }
    super.set(key, value)
    this.weights.set(key, bytes)
    this.bytes += bytes
    const timer = setTimeout(() => this.delete(key), EDITOR_PROPOSAL_TTL_MS)
    unref(timer)
    this.timers.set(key, timer)
    return this
  }

  override delete(key: K): boolean {
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    this.bytes -= this.weights.get(key) ?? 0
    this.weights.delete(key)
    return super.delete(key)
  }

  override clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.weights.clear()
    this.bytes = 0
    super.clear()
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const record = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(record[key]))
      .join(',') +
    '}'
  )
}

/** A fixed-size receipt identity: legal large arguments never consume the receipt budget. */
export async function editorRequestFingerprint(frame: EditorRequestFrame): Promise<string> {
  const payload = canonical({
    documentId: frame.target.documentId,
    editorType: frame.target.editorType,
    command: frame.command,
    arguments: frame.arguments,
    planHash: frame.approval?.planHash,
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface EditorJournalRecord {
  fingerprint: string
  result: AgentToolResult
}
type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
interface IndexEntry {
  id: string
  expiresAt: number
  bytes: number
}
interface MemoryEntry {
  raw: string
  expiresAt: number
  bytes: number
}

/** Fixed-lifetime, bounded receipts. Storage errors never change an executed operation's result. */
export function createEditorResultJournal(storage: JournalStorage | undefined, documentId: string) {
  const memory = new Map<string, MemoryEntry>()
  let memoryBytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let lastIndex: IndexEntry[] = []
  const prefix = 'nexusdesk:editor-result:' + documentId + ':'
  const indexKey = 'nexusdesk:editor-result-index:' + documentId
  const remove = (key: string): boolean => {
    try {
      storage?.removeItem(key)
      return true
    } catch {
      return false
    }
  }
  const readIndex = (): IndexEntry[] | undefined => {
    try {
      const raw = storage?.getItem(indexKey) ?? '[]'
      if (byteLength(raw) > EDITOR_JOURNAL_MAX_BYTES) return undefined
      const value: unknown = JSON.parse(raw)
      if (!Array.isArray(value) || value.length > EDITOR_JOURNAL_LIMIT) return undefined
      // Pre-TTL journals cannot provide a verifiable lifetime: remove their old indexed keys.
      if (value.length > 0 && value.every((item) => typeof item === 'string')) {
        if (!value.every((id) => remove(prefix + id)) || !remove(indexKey)) return undefined
        return []
      }
      if (
        !value.every(
          (entry) =>
            entry &&
            typeof entry.id === 'string' &&
            entry.id.length <= 256 &&
            Number.isFinite(entry.expiresAt) &&
            Number.isFinite(entry.bytes) &&
            entry.bytes > 0,
        )
      )
        return undefined
      lastIndex = value as IndexEntry[]
      return lastIndex
    } catch {
      return undefined
    }
  }
  const writeIndex = (index: IndexEntry[]): void => {
    if (index.length) storage?.setItem(indexKey, JSON.stringify(index))
    else storage?.removeItem(indexKey)
    lastIndex = index
  }
  const deleteMemory = (id: string): void => {
    memoryBytes -= memory.get(id)?.bytes ?? 0
    memory.delete(id)
  }
  const remember = (id: string, entry: MemoryEntry): void => {
    if (entry.bytes > EDITOR_JOURNAL_TOTAL_BYTES) return
    deleteMemory(id)
    while (
      memory.size >= EDITOR_JOURNAL_LIMIT ||
      memoryBytes + entry.bytes > EDITOR_JOURNAL_TOTAL_BYTES
    ) {
      deleteMemory(memory.keys().next().value!)
    }
    memory.set(id, entry)
    memoryBytes += entry.bytes
  }
  const prune = (index: IndexEntry[]): IndexEntry[] | undefined => {
    const alive: IndexEntry[] = []
    for (const entry of index) {
      if (entry.expiresAt > Date.now()) alive.push(entry)
      else if (!remove(prefix + entry.id)) return undefined
    }
    if (alive.length !== index.length) writeIndex(alive)
    return alive
  }
  const schedule = (): void => {
    clearTimeout(timer)
    timer = undefined
    const next = Math.min(...[...memory.values(), ...lastIndex].map((entry) => entry.expiresAt))
    if (!Number.isFinite(next)) return
    timer = setTimeout(cleanup, next <= Date.now() ? 1_000 : next - Date.now())
    unref(timer)
  }
  function cleanup(): void {
    for (const [id, entry] of memory) if (entry.expiresAt <= Date.now()) deleteMemory(id)
    try {
      const index = readIndex()
      if (index) prune(index)
    } catch {
      /* A denied cleanup is retried later; expired records are never replayed. */
    }
    schedule()
  }
  const storageBytes = (index: IndexEntry[]): number =>
    index.reduce((total, entry) => total + entry.bytes, 0) +
    byteLength(indexKey + JSON.stringify(index))

  const write = (operationId: string, record: EditorJournalRecord): void => {
    if (operationId.length > 256) return
    const expiresAt = Date.now() + EDITOR_JOURNAL_TTL_MS
    const raw = JSON.stringify({ ...record, expiresAt })
    if (byteLength(raw) > EDITOR_JOURNAL_MAX_BYTES) return
    cleanup()
    const bytes = byteLength(prefix + operationId + raw)
    if (!closed) remember(operationId, { raw, expiresAt, bytes })
    try {
      const prior = readIndex()
      if (storage && prior) {
        const alive = prune(prior)
        if (!alive) return
        if (alive.some((entry) => entry.id === operationId) && !remove(prefix + operationId)) return
        const index = alive.filter((entry) => entry.id !== operationId)
        index.push({ id: operationId, expiresAt, bytes })
        while (
          index.length > EDITOR_JOURNAL_LIMIT ||
          storageBytes(index) > EDITOR_JOURNAL_TOTAL_BYTES
        ) {
          if (!remove(prefix + index.shift()!.id)) return
        }
        // Index first: a failed record write cannot leave an unindexed persistent key.
        writeIndex(index)
        storage.setItem(prefix + operationId, raw)
      }
    } catch {
      /* Memory still has the terminal receipt. */
    } finally {
      schedule()
    }
  }
  cleanup()
  return {
    read(operationId: string): EditorJournalRecord | undefined {
      if (closed || operationId.length > 256) return undefined
      cleanup()
      const cached = memory.get(operationId)
      if (cached) {
        const { fingerprint, result } = JSON.parse(cached.raw) as EditorJournalRecord
        return { fingerprint, result }
      }
      try {
        const entry = readIndex()?.find(
          (entry) => entry.id === operationId && entry.expiresAt > Date.now(),
        )
        if (!entry) return undefined
        const raw = storage?.getItem(prefix + operationId)
        if (!raw) return undefined
        if (byteLength(raw) > EDITOR_JOURNAL_MAX_BYTES) {
          remove(prefix + operationId)
          return undefined
        }
        const record = JSON.parse(raw) as EditorJournalRecord & { expiresAt: number }
        if (
          typeof record.fingerprint !== 'string' ||
          typeof record.result?.ok !== 'boolean' ||
          record.expiresAt !== entry.expiresAt
        ) {
          remove(prefix + operationId)
          return undefined
        }
        remember(operationId, {
          raw,
          expiresAt: entry.expiresAt,
          bytes: byteLength(prefix + operationId + raw),
        })
        schedule()
        return { fingerprint: record.fingerprint, result: record.result }
      } catch {
        remove(prefix + operationId)
        return undefined
      }
    },
    write,
    clearMemory() {
      closed = true
      clearTimeout(timer)
      memory.clear()
      memoryBytes = 0
      // Keep only the bounded expiry metadata until persistent keys are cleaned.
      // An already-started mutation may still finish and write a durable receipt.
      schedule()
    },
  }
}
