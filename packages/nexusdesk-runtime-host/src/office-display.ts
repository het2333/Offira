const PREFIX = 'NexusDesk Office context (Host-validated and frozen at submission):\n'

function isOfficeContext(part: unknown, documentId: string): boolean {
  if (!part || typeof part !== 'object') return false
  const text = (part as { type?: string; text?: unknown }).text
  if ((part as { type?: string }).type !== 'text' || typeof text !== 'string' || !text.startsWith(PREFIX)) return false
  try {
    const value = JSON.parse(text.slice(PREFIX.length))
    return value.documentId === documentId && typeof value.editorType === 'string' &&
      Number.isInteger(value.revision) && Object.hasOwn(value, 'selection') &&
      Object.keys(value).sort().join(',') === 'documentId,editorType,revision,selection'
  } catch { return false }
}

/** Presentation-only copy. Never use this projection as model input or durable history. */
export function projectOfficeDisplay<T>(value: T, documentId: string): T {
  if (Array.isArray(value)) return value.map((item) => projectOfficeDisplay(item, documentId)) as T
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const copy = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, projectOfficeDisplay(item, documentId)]))
  if (record.role === 'user' && Array.isArray(record.content) && record.content.length > 1 && isOfficeContext(record.content[0], documentId)) {
    copy.content = record.content.slice(1)
  }
  return copy as T
}
