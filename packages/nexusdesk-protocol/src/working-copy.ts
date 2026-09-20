import { z } from 'zod'
import type { AgentToolResult } from './editor'
import { parseAgentToolResult } from './schemas'

export type CheckpointPayloadKind = 'docx-bytes' | 'xlsx-save-plan' | 'pdf-save-plan'
export type WorkingCopyRecoveryState = 'ready' | 'conflict'
export interface WorkingCopyBootstrap {
  documentEpoch: string
  workingRevision: number
  savedRevision: number
  sourceContentId: string
  checkpointId: string | null
  dirty: boolean
  recoveryState: WorkingCopyRecoveryState
  contentUrl: string
}
export interface PersistenceReference {
  documentEpoch: string
  operationId: string
  requestFingerprint: string
  checkpointId: string
  blobHash: string
  workingRevision: number
  savedRevision: number
  dirty: boolean
}
export interface CheckpointMetadata {
  schemaVersion: 1
  requestId: string
  clientId: string
  documentEpoch: string
  operationId: string
  expectedWorkingRevision: number
  expectedSavedRevision: number
  sourceContentId: string
  planHash: string
  result: AgentToolResult
  payloadKind: CheckpointPayloadKind
}
export type WorkingCopyLookup =
  | { state: 'committed'; persistence: PersistenceReference; result: AgentToolResult }
  | { state: 'pending' | 'not-found' }

const text = z.string().min(1).max(4096)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().nonnegative().safe()
export const persistenceReferenceSchema = z.object({
  documentEpoch: text, operationId: text, requestFingerprint: hash, checkpointId: text,
  blobHash: hash, workingRevision: revision, savedRevision: revision, dirty: z.boolean(),
}).strict()
export const workingCopyBootstrapSchema = z.object({
  documentEpoch: text, workingRevision: revision, savedRevision: revision,
  sourceContentId: hash, checkpointId: text.nullable(), dirty: z.boolean(),
  recoveryState: z.enum(['ready', 'conflict']), contentUrl: text,
}).strict()
export const checkpointMetadataSchema = z.object({
  schemaVersion: z.literal(1), requestId: text, clientId: text, documentEpoch: text,
  operationId: text, expectedWorkingRevision: revision, expectedSavedRevision: revision,
  sourceContentId: hash, planHash: text,
  result: z.unknown().transform((value) => parseAgentToolResult(value)),
  payloadKind: z.enum(['docx-bytes', 'xlsx-save-plan', 'pdf-save-plan']),
}).strict()
export const manualSaveMetadataSchema = z.object({
  operationId: text, documentEpoch: text, sourceContentId: hash,
  expectedWorkingRevision: revision, expectedSavedRevision: revision,
  payloadKind: z.enum(['docx-bytes', 'xlsx-save-plan', 'pdf-save-plan']), snapshotHash: hash,
}).strict()
export type ManualSaveMetadata = z.infer<typeof manualSaveMetadataSchema>
export const checkpointPartSchema = z.object({
  partId: z.string().regex(/^(document|manifest|edits-\d{4}|asset-\d{4})$/),
  sha256: hash, byteLength: revision.max(134_217_728),
}).strict()
export type CheckpointPart = z.infer<typeof checkpointPartSchema>
export const checkpointCommitSchema = z.object({ parts: z.array(checkpointPartSchema).min(1).max(4096) }).strict()
export const workingCopyLookupSchema = z.object({
  documentEpoch: text, operationId: text, requestFingerprint: hash,
}).strict()

/** Canonical JSON shared by browser request identity and Host authorization. */
export function canonicalOperationJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || value === undefined) throw new TypeError('operation requires JSON values')
  if (seen.has(value)) throw new TypeError('operation must not contain cycles')
  seen.add(value)
  const encoded = Array.isArray(value)
    ? '[' + value.map((entry) => canonicalOperationJson(entry, seen)).join(',') + ']'
    : '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + canonicalOperationJson((value as Record<string, unknown>)[key], seen)).join(',') + '}'
  seen.delete(value)
  return encoded
}
