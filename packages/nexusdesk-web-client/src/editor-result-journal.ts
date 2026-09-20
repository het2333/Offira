import type { AgentToolResult } from '@nexusdesk/protocol'

export const EDITOR_JOURNAL_LIMIT = 128
export const EDITOR_JOURNAL_MAX_BYTES = 64 * 1024

/** An insertion/access ordered cache with a fixed entry bound. */
export class BoundedEditorCache<K, V> extends Map<K, V> {
  override get(key: K): V | undefined {
    const value = super.get(key)
    if (value !== undefined) {
      super.delete(key)
      super.set(key, value)
    }
    return value
  }
  override set(key: K, value: V): this {
    super.delete(key)
    super.set(key, value)
    while (this.size > EDITOR_JOURNAL_LIMIT) super.delete(this.keys().next().value as K)
    return this
  }
}

export interface EditorJournalRecord {
  fingerprint: string
  result: AgentToolResult
}
type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Storage is best-effort; bounded memory preserves recent results if a browser denies it. */
export function createEditorResultJournal(storage: JournalStorage | undefined, documentId: string) {
  const memory = new BoundedEditorCache<string, EditorJournalRecord>()
  const prefix = `nexusdesk:editor-result:${documentId}:`
  const indexKey = `nexusdesk:editor-result-index:${documentId}`
  const remove = (key: string): boolean => {
    try {
      storage?.removeItem(key)
      return true
    } catch {
      return false
    }
  }
  const readIndex = (): string[] | undefined => {
    try {
      const raw = storage?.getItem(indexKey) ?? '[]'
      if (raw.length > EDITOR_JOURNAL_MAX_BYTES) return undefined
      const value: unknown = JSON.parse(raw)
      return Array.isArray(value) && value.length <= EDITOR_JOURNAL_LIMIT
        ? value.filter((id): id is string => typeof id === 'string' && id.length <= 256)
        : undefined
    } catch {
      return undefined
    }
  }
  const write = (operationId: string, record: EditorJournalRecord): void => {
    if (operationId.length > 256) return
    const raw = JSON.stringify(record)
    if (new TextEncoder().encode(raw).byteLength > EDITOR_JOURNAL_MAX_BYTES) return
    memory.set(operationId, record)
    if (!storage) return
    try {
      const prior = readIndex()
      // Without a readable index, adding persistent keys could exceed the cap.
      if (!prior) return
      const index = prior.filter((id) => id !== operationId)
      while (index.length >= EDITOR_JOURNAL_LIMIT) {
        if (!remove(prefix + index.shift()!)) return
      }
      index.push(operationId)
      // Reserve the bounded index before writing a record; index failures cannot orphan keys.
      storage.setItem(indexKey, JSON.stringify(index))
      storage.setItem(prefix + operationId, raw)
    } catch {
      /* A storage failure cannot change the executed operation's result. */
    }
  }
  return {
    read(operationId: string): EditorJournalRecord | undefined {
      const cached = memory.get(operationId)
      if (cached) return cached
      try {
        const raw = storage?.getItem(prefix + operationId)
        if (!raw) return undefined
        if (new TextEncoder().encode(raw).byteLength > EDITOR_JOURNAL_MAX_BYTES) {
          remove(prefix + operationId)
          return undefined
        }
        const record = JSON.parse(raw) as EditorJournalRecord
        if (typeof record.fingerprint !== 'string' || typeof record.result?.ok !== 'boolean') {
          remove(prefix + operationId)
          return undefined
        }
        write(operationId, record)
        return record
      } catch {
        remove(prefix + operationId)
        return undefined
      }
    },
    write,
    clearMemory() {
      memory.clear()
    },
  }
}
