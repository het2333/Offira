import { z } from 'zod'
import type { DocumentId, RequestId, Revision, SessionId } from './identity'

interface NativeBase {
  protocolVersion: 1
  id: RequestId
  documentId: DocumentId
}
export type HarnessClientFrame =
  | (NativeBase & { type: 'harness:bind' })
  | (NativeBase & {
      type: 'harness:prepare'
      requestId: string
      revision: Revision
      selection: unknown
    })
  | (NativeBase & {
      type: 'harness:rpc' | 'harness:stream-open'
      endpoint: string
      payload: unknown
    })
  | (NativeBase & { type: 'harness:stream-cancel'; streamId: string })

export type HarnessServerFrame =
  | (NativeBase & { type: 'harness:bound'; sessionId: SessionId })
  | (NativeBase & { type: 'harness:prepared'; requestId: string })
  | (NativeBase & { type: 'harness:result'; result: unknown })
  | (NativeBase & { type: 'harness:stream-item'; value: unknown })
  | (NativeBase & { type: 'harness:stream-end' })
  | (NativeBase & { type: 'harness:error'; message: string })

const id = z.string().min(1).max(512)
const base = { protocolVersion: z.literal(1), id, documentId: id }
const endpoint = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z0-9_$-]+(?:\/[a-zA-Z0-9_$-]+)*$/)
const boundedObject = z.record(z.string(), z.unknown()).refine((value) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 512 * 1024
  } catch {
    return false
  }
}, 'Native carrier payload exceeds 512 KiB.')

/** Envelope admission only; exact capabilities and selection schemas are checked by the Host. */
export const harnessClientFrameSchemas = [
  z.object({ ...base, type: z.literal('harness:bind') }).strict(),
  z
    .object({
      ...base,
      type: z.literal('harness:prepare'),
      requestId: id,
      revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      selection: boundedObject,
    })
    .strict(),
  z.object({ ...base, type: z.literal('harness:rpc'), endpoint, payload: boundedObject }).strict(),
  z
    .object({ ...base, type: z.literal('harness:stream-open'), endpoint, payload: boundedObject })
    .strict(),
  z.object({ ...base, type: z.literal('harness:stream-cancel'), streamId: id }).strict(),
] as const
