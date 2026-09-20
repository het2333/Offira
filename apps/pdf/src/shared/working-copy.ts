import { assertPdfWebPayload } from '@nexusdesk/protocol'
import type { SavePdfRequest } from './ipc'
import type { PdfPageModification } from './web-capabilities'

const JSON_PART_LIMIT = 262_144
const encoder = new TextEncoder()
const lists = [
  'markups',
  'annotDeletes',
  'drawings',
  'noteEdits',
  'formValues',
  'stamps',
  'textEdits',
  'textInserts',
  'imageEdits',
  'redactions',
  'staticFormFills',
  'rotations',
  'deletedPages',
  'pageOrder',
] as const
type Manifest = {
  schemaVersion: 1
  metadata?: SavePdfRequest['metadata']
  lists: Partial<Record<(typeof lists)[number], string[]>>
  modification?: PdfPageModification
}
const jsonBytes = (value: unknown): Uint8Array => {
  const bytes = encoder.encode(JSON.stringify(value))
  if (bytes.byteLength > JSON_PART_LIMIT)
    throw new Error('PDF working-copy JSON record exceeds the part limit')
  return bytes
}

/** Snapshot synchronously. Only the serializer boundary ever sees image base64 again. */
export function encodePdfWorkingCopy(
  request: SavePdfRequest,
  modification?: PdfPageModification,
): ReadonlyMap<string, Uint8Array> {
  assertPdfWebPayload({ request })
  if (request.targetPath || request.redactions?.length)
    throw new Error('Unsupported PDF working-copy save')
  const parts = new Map<string, Uint8Array>()
  let asset = 0
  let chunk = 0
  const manifest: Manifest = {
    schemaVersion: 1,
    lists: {},
    ...(request.metadata ? { metadata: request.metadata } : {}),
    ...(modification ? { modification } : {}),
  }
  const extract = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(extract)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key !== 'image') return [key, extract(item)]
        if (typeof item !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item))
          throw new Error('Invalid PDF image asset')
        const id = `asset-${String(asset++).padStart(4, '0')}`
        parts.set(
          id,
          Uint8Array.from(atob(item), (c) => c.charCodeAt(0)),
        )
        return ['assetRef', id]
      }),
    )
  }
  for (const key of lists) {
    const values = request[key]
    if (values === undefined) continue
    const ids: string[] = []
    let batch: unknown[] = []
    let length = 2
    const flush = () => {
      if (batch.length === 0) return
      const id = `edits-${String(chunk++).padStart(4, '0')}`
      parts.set(id, jsonBytes(batch))
      ids.push(id)
      batch = []
      length = 2
    }
    for (const value of values) {
      const record = extract(value)
      const size = jsonBytes(record).byteLength
      if (size + 2 > JSON_PART_LIMIT)
        throw new Error('PDF working-copy JSON record exceeds the part limit')
      if (length + size + (batch.length ? 1 : 0) > JSON_PART_LIMIT) flush()
      length += size + (batch.length ? 1 : 0)
      batch.push(record)
    }
    flush()
    manifest.lists[key] = ids
  }
  parts.set('manifest', jsonBytes(manifest))
  return parts
}

export function decodePdfWorkingCopy(parts: ReadonlyMap<string, Uint8Array>): {
  request: SavePdfRequest
  modification?: PdfPageModification
} {
  const used = new Set<string>()
  const part = (id: string) => {
    const bytes = parts.get(id)
    if (!bytes || used.has(id)) throw new Error('Missing or repeated PDF working-copy part')
    used.add(id)
    return bytes
  }
  const json = (id: string): unknown => {
    const bytes = part(id)
    if (bytes.byteLength > JSON_PART_LIMIT)
      throw new Error('PDF working-copy JSON part exceeds limit')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  const manifest = json('manifest') as Manifest
  if (
    manifest?.schemaVersion !== 1 ||
    !manifest.lists ||
    Object.keys(manifest).some(
      (key) => !['schemaVersion', 'metadata', 'lists', 'modification'].includes(key),
    )
  )
    throw new Error('Invalid PDF working-copy manifest')
  const restore = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(restore)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key === 'image' || key === 'path' || key === 'targetPath')
          throw new Error('Inline PDF asset or path is forbidden')
        if (key !== 'assetRef') return [key, restore(item)]
        if (typeof item !== 'string' || !/^asset-\d{4,}$/.test(item))
          throw new Error('Invalid PDF asset reference')
        const bytes = part(item)
        let binary = ''
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
        return ['image', btoa(binary)]
      }),
    )
  }
  const request: Record<string, unknown> = {
    path: '',
    ...(manifest.metadata ? { metadata: manifest.metadata } : {}),
  }
  for (const [key, ids] of Object.entries(manifest.lists)) {
    if (!(lists as readonly string[]).includes(key) || !Array.isArray(ids))
      throw new Error('Invalid PDF working-copy list')
    request[key] = ids.flatMap((id) => {
      if (typeof id !== 'string' || !/^edits-\d{4,}$/.test(id))
        throw new Error('Invalid PDF edit reference')
      const value = json(id)
      if (!Array.isArray(value)) throw new Error('Invalid PDF edit part')
      return value.map(restore)
    })
  }
  if (used.size !== parts.size) throw new Error('Unreferenced PDF working-copy parts')
  assertPdfWebPayload({ request })
  return {
    request: request as unknown as SavePdfRequest,
    ...(manifest.modification ? { modification: manifest.modification } : {}),
  }
}

export function pdfSaveHasEdits(request: SavePdfRequest): boolean {
  return lists.some((key) => (request[key]?.length ?? 0) > 0) || request.metadata !== undefined
}
