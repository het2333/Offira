import { persistenceReferenceSchema, parseAgentToolResult, canonicalOperationJson,
  type AgentToolResult, type CheckpointPart, type CheckpointPayloadKind, type EditorRequestFrame,
  type PersistenceReference, type WorkingCopyBootstrap, type WorkingCopyLookup } from '@nexusdesk/protocol'

export interface BrowserWorkingCopyPayload { kind: CheckpointPayloadKind; parts: ReadonlyMap<string, Blob> }
export interface BrowserWorkingCopyPersistence {
  checkpoint(frame: EditorRequestFrame, result: AgentToolResult, payload: BrowserWorkingCopyPayload): Promise<PersistenceReference>
  lookup(operationId: string, requestFingerprint: string): Promise<WorkingCopyLookup>
}
export interface BrowserWorkingCopyManualPersistence {
  saveManual(operationId: string, payload: BrowserWorkingCopyPayload): Promise<PersistenceReference>
}
/** Share this lane between Agent mutation, capture and toolbar/keyboard Save. */
export function createWorkingCopyMutationLane() {
  let tail: Promise<unknown> = Promise.resolve()
  return { run<T>(task: () => Promise<T>): Promise<T> {
    const pending = tail.then(task)
    tail = pending.catch(() => undefined)
    return pending
  } }
}
export class BrowserWorkingCopyError extends Error {
  constructor(readonly code: string, message: string, readonly requestFingerprint?: string) { super(message); this.name = 'BrowserWorkingCopyError' }
}
export interface BrowserWorkingCopyOptions {
  documentId: string
  origin: string
  state(): WorkingCopyBootstrap | null
  clientId(): string | undefined
  fetch?: typeof fetch
}
/** Uploads bytes outside JSON/WS. An uncertain commit only triggers lookup, never a second mutation. */
export function createBrowserWorkingCopyPersistence(options: BrowserWorkingCopyOptions): BrowserWorkingCopyPersistence & BrowserWorkingCopyManualPersistence {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const base = options.origin + '/api/documents/' + encodeURIComponent(options.documentId)
  const request = async (path: string, method: string, body: string | Blob): Promise<unknown> => {
    const clientId = options.clientId()
    if (!clientId) throw new BrowserWorkingCopyError('WORKING_COPY_OUTCOME_UNKNOWN', 'The editor is disconnected.')
    let response: Response
    let value: { code?: string; message?: string }
    try {
      response = await fetcher(base + path, { method, credentials: 'include',
        headers: { 'Content-Type': body instanceof Blob ? 'application/octet-stream' : 'application/json', 'X-NexusDesk-Client-Id': clientId }, body })
      value = await response.json() as { code?: string; message?: string }
    } catch (cause) {
      throw new BrowserWorkingCopyError('WORKING_COPY_OUTCOME_UNKNOWN', cause instanceof Error ? cause.message : 'Working-copy response was lost.')
    }
    if (!response.ok) throw new BrowserWorkingCopyError(value.code ?? 'WORKING_COPY_PERSIST_FAILED', value.message ?? 'Working-copy request failed.')
    return value
  }
  const state = () => {
    const value = options.state()
    if (!value || value.recoveryState !== 'ready') throw new BrowserWorkingCopyError('WORKING_COPY_RECOVERY_REQUIRED', 'Hydrate the current working copy before saving.')
    return value
  }
  const lookup = async (operationId: string, requestFingerprint: string): Promise<WorkingCopyLookup> => {
    const documentEpoch = state().documentEpoch
    const value = await request('/operations/lookup', 'POST', JSON.stringify({ documentEpoch, operationId, requestFingerprint })) as WorkingCopyLookup
    if (value.state === 'committed') {
      const persistence = persistenceReferenceSchema.parse(value.persistence)
      if (persistence.operationId !== operationId || persistence.requestFingerprint !== requestFingerprint || persistence.documentEpoch !== documentEpoch) {
        throw new BrowserWorkingCopyError('WORKING_COPY_RECOVERY_INVALID', 'Lookup returned a receipt for a different operation.')
      }
      return { state: 'committed', persistence, result: parseAgentToolResult(value.result) }
    }
    if (value.state !== 'pending' && value.state !== 'not-found') throw new BrowserWorkingCopyError('WORKING_COPY_RECOVERY_INVALID', 'Invalid operation lookup response.')
    return value
  }
  const complete = async (created: { uploadId: string; requestFingerprint: string }, operationId: string,
    payload: BrowserWorkingCopyPayload, current: WorkingCopyBootstrap): Promise<PersistenceReference> => {
    try {
      const parts: CheckpointPart[] = []
      for (const [partId, blob] of payload.parts) {
        parts.push(await request('/checkpoint-uploads/' + encodeURIComponent(created.uploadId) + '/parts/' + encodeURIComponent(partId), 'PUT', blob) as CheckpointPart)
      }
      const committed = await request('/checkpoint-uploads/' + encodeURIComponent(created.uploadId) + '/commit', 'POST', JSON.stringify({ parts })) as { persistence: PersistenceReference }
      const receipt = persistenceReferenceSchema.parse(committed.persistence)
      if (receipt.operationId !== operationId || receipt.requestFingerprint !== created.requestFingerprint ||
          receipt.documentEpoch !== current.documentEpoch) throw new BrowserWorkingCopyError('WORKING_COPY_RECOVERY_INVALID', 'Checkpoint receipt identity changed.')
      return receipt
    } catch (cause) {
      try {
        const recovered = await lookup(operationId, created.requestFingerprint)
        if (recovered.state === 'committed') return recovered.persistence
      } catch { /* Preserve the uncertain attempt even when lookup also fails. */ }
      throw new BrowserWorkingCopyError('WORKING_COPY_OUTCOME_UNKNOWN',
        cause instanceof Error ? cause.message : 'Checkpoint outcome is unknown; restore and query before continuing.', created.requestFingerprint)
    }
  }
  return {
    lookup,
    async saveManual(operationId, payload) {
      const current = state()
      const digest = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (byte) => byte.toString(16).padStart(2, '0')).join('')
      const entries = await Promise.all([...payload.parts].map(async ([key, blob]) => [key, await digest(await blob.arrayBuffer())]))
      const snapshotHash = await digest(new TextEncoder().encode(canonicalOperationJson(entries.sort())).buffer)
      const created = await request('/manual-save-uploads', 'POST', JSON.stringify({
        operationId, documentEpoch: current.documentEpoch, sourceContentId: current.sourceContentId,
        expectedWorkingRevision: current.workingRevision, expectedSavedRevision: current.savedRevision,
        payloadKind: payload.kind, snapshotHash,
      })) as { uploadId: string; operationId: string; requestFingerprint: string }
      return complete(created, created.operationId, payload, current)
    },
    async checkpoint(frame, result, payload) {
      const current = state()
      if (frame.target.documentId !== options.documentId || !frame.approval || !result.ok) {
        throw new BrowserWorkingCopyError('OPERATION_NOT_AUTHORIZED', 'Checkpoint requires an approved successful document operation.')
      }
      const created = await request('/checkpoint-uploads', 'POST', JSON.stringify({
        schemaVersion: 1, requestId: frame.id, clientId: options.clientId(), documentEpoch: current.documentEpoch,
        operationId: frame.target.operationId, expectedWorkingRevision: current.workingRevision,
        expectedSavedRevision: current.savedRevision, sourceContentId: current.sourceContentId,
        planHash: frame.approval.planHash, result, payloadKind: payload.kind,
      })) as { uploadId: string; requestFingerprint: string }
      return complete(created, frame.target.operationId, payload, current)
    },
  }
}
