import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalOperationJson, checkpointMetadataSchema, manualSaveMetadataSchema,
  type AgentToolResult, type CheckpointMetadata, type CheckpointPart, type CheckpointPayloadKind,
  type ClientId, type DocumentId, type EditorRegisterFrame, type EditorRequestFrame,
  type PersistenceReference, type WorkingCopyBootstrap, type WorkingCopyLookup,
  type ManualSaveMetadata,
} from '@nexusdesk/protocol'
import { DocumentDriverRegistry } from './document-driver'
import { DocumentRegistry } from './document-registry'
import { CheckpointUploadStore } from './checkpoint-upload-store'
import { operationRequestFingerprint } from './operation-store'
import { type WorkingCopyOperationBinding, type WorkingCopyReceipt } from './working-copy-store'

const hash = (input: Uint8Array | string) => createHash('sha256').update(input).digest('hex')
const copy = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T
const fail = (code: string, message: string): never => { throw new WorkingCopyCoordinatorError(code, message) }
export class WorkingCopyCoordinatorError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WorkingCopyCoordinatorError' }
}
export function persistenceReference(receipt: WorkingCopyReceipt): PersistenceReference {
  const { documentEpoch, operationId, requestFingerprint, checkpointId, blobHash, workingRevision, savedRevision, dirty } = receipt
  return { documentEpoch, operationId, requestFingerprint, checkpointId, blobHash, workingRevision, savedRevision, dirty }
}
export const isWorkingCopyMutation = (command: string): boolean =>
  ['apply_ops', 'apply_history', 'save_document', 'save_sheet', 'save_pdf'].includes(command)

interface Lease { generation: string; clientId: string; rendererInstanceId: string; sourceContentId: string; documentEpoch: string; httpSession: string }
interface Reservation {
  documentId: string
  operationId: string
  requestId: string
  lease: Lease
  binding: WorkingCopyOperationBinding
  promote: boolean
}
interface Upload { reservation: Reservation; metadata: CheckpointMetadata }
interface Terminal { persistence: PersistenceReference; result: AgentToolResult }
export interface WorkingCopyCoordinatorOptions {
  drivers: DocumentDriverRegistry
  documents: DocumentRegistry
  uploadRoot?: string
}
export interface ManualWorkingCopySave {
  documentId: string
  clientId: string
  operationId: string
  documentEpoch: string
  sourceContentId: string
  expectedWorkingRevision: number
  expectedSavedRevision: number
  payloadKind: CheckpointPayloadKind
  parts: ReadonlyMap<string, Uint8Array>
}

/** A single Host must own a recovery document. This lane does not claim a cross-process writer lock. */
export class WorkingCopyCoordinator {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly leases = new Map<string, Lease>()
  private readonly sources = new Map<string, { bootstrap: WorkingCopyBootstrap; expiresAt: number }>()
  private readonly rendererHeads = new Map<string, { bootstrap: WorkingCopyBootstrap; httpSession: string }>()
  private readonly reservations = new Map<string, Reservation>()
  private readonly completedUploads = new Map<string, Upload>()
  private readonly uploads: CheckpointUploadStore<Upload>
  constructor(private readonly options: WorkingCopyCoordinatorOptions) {
    this.uploads = new CheckpointUploadStore({ ...(options.uploadRoot === undefined ? {} : { rootDirectory: options.uploadRoot }),
      groupKey: (upload) => upload.reservation.documentId, maxUploadsPerGroup: 2 })
  }
  enabled(documentId: string): boolean { return this.options.drivers.require(documentId).workingCopy !== undefined }
  private port(documentId: string) {
    return this.options.drivers.require(documentId).workingCopy ?? fail('UNSUPPORTED_CAPABILITY', 'This document has no durable working-copy port.')
  }
  private lane<T>(documentId: string, task: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(documentId) ?? Promise.resolve()).then(task)
    const tail = pending.then(() => undefined, () => undefined)
    this.queues.set(documentId, tail)
    void tail.then(() => { if (this.queues.get(documentId) === tail) this.queues.delete(documentId) })
    return pending
  }
  private key(documentId: string, operationId: string): string { return JSON.stringify([documentId, operationId]) }
  private owner(documentId: string, clientId: string): Lease {
    const document = this.options.documents.assertClient(documentId as DocumentId, clientId as ClientId)
    const lease = this.leases.get(documentId)
    if (!lease || lease.clientId !== clientId || lease.rendererInstanceId !== document.rendererInstanceId) {
      return fail('WORKING_COPY_STALE_OWNER', 'The renderer must hydrate and register before changing this working copy.')
    }
    return lease
  }
  private assertLease(reservation: Reservation, clientId: string): void {
    const lease = this.owner(reservation.documentId, clientId)
    if (lease.generation !== reservation.lease.generation) fail('WORKING_COPY_STALE_OWNER', 'The upload belongs to an earlier renderer generation.')
  }
  private async refresh(documentId: string, publishToRenderer = false): Promise<void> {
    const status = await this.port(documentId).store.getStatus()
    const driver = this.options.drivers.require(documentId)
    driver.document.revision = status.workingRevision
    this.options.documents.refreshFromHost(driver.document)
    this.options.documents.setWorkingCopyHead(documentId, { documentEpoch: status.documentEpoch,
      checkpointId: status.head?.checkpointId ?? null, workingRevision: status.workingRevision })
    const lease = this.leases.get(documentId)
    if (publishToRenderer && lease) {
      const renderer = this.rendererHeads.get(this.key(documentId, lease.rendererInstanceId))
      if (renderer) {
        renderer.bootstrap = { ...renderer.bootstrap, workingRevision: status.workingRevision, savedRevision: status.savedRevision,
          checkpointId: status.head?.checkpointId ?? null, dirty: status.dirty }
      }
    }
  }
  async bootstrap(documentId: string, origin: string, httpSession: string): Promise<WorkingCopyBootstrap> {
    return this.lane(documentId, async () => {
      const port = this.port(documentId)
      const status = await port.store.getStatus()
      if (status.recoveryState !== 'ready') fail('REVISION_CONFLICT', 'The original file changed; working-copy recovery requires attention.')
      const source = await port.acquireSource()
      const state: WorkingCopyBootstrap = { documentEpoch: status.documentEpoch, workingRevision: status.workingRevision,
        savedRevision: status.savedRevision, sourceContentId: source.sourceContentId, checkpointId: status.head?.checkpointId ?? null,
        dirty: status.dirty, recoveryState: status.recoveryState,
        contentUrl: origin + '/api/documents/' + encodeURIComponent(documentId) + '/sources/' + source.sourceContentId + '/content' }
      for (const [key, entry] of this.sources) if (entry.expiresAt <= Date.now()) this.sources.delete(key)
      if (this.sources.size >= 1024) fail('UPLOAD_LIMIT', 'Too many pending hydration sources.')
      this.sources.set(JSON.stringify([httpSession, documentId, source.sourceContentId]), { bootstrap: state, expiresAt: Date.now() + 600_000 })
      await this.refresh(documentId)
      return state
    })
  }
  async readSource(documentId: string, httpSession: string, sourceContentId: string): Promise<Uint8Array> {
    const issued = this.sources.get(JSON.stringify([httpSession, documentId, sourceContentId]))
    if (!issued || issued.expiresAt <= Date.now()) fail('WORKING_COPY_STALE_SOURCE', 'This source is not leased to this authenticated document session.')
    return this.port(documentId).readSource(sourceContentId)
  }
  register(frame: EditorRegisterFrame, httpSession: string): Promise<void> {
    return this.lane(frame.documentId, async () => {
      const status = await this.port(frame.documentId).store.getStatus()
      const issued = this.sources.get(JSON.stringify([httpSession, frame.documentId, frame.sourceContentId]))
      const renderer = this.rendererHeads.get(this.key(frame.documentId, frame.rendererInstanceId))
      const matches = (state: WorkingCopyBootstrap | undefined) => state?.documentEpoch === frame.documentEpoch &&
        state?.workingRevision === frame.revision && state?.sourceContentId === frame.sourceContentId &&
        state?.checkpointId === frame.restoredCheckpointId
      const resumed = renderer?.httpSession === httpSession && matches(renderer.bootstrap)
      const fresh = issued !== undefined && issued.expiresAt > Date.now() && matches(issued.bootstrap)
      if ((!resumed && !fresh) || status.recoveryState !== 'ready' ||
          frame.documentEpoch !== status.documentEpoch || frame.revision !== status.workingRevision ||
          frame.restoredCheckpointId !== (status.head?.checkpointId ?? null)) {
        fail('REVISION_CONFLICT', 'Hydrated content is no longer the current head; bootstrap and restore again.')
      }
      await this.refresh(frame.documentId)
      this.options.documents.register(frame)
      this.rendererHeads.set(this.key(frame.documentId, frame.rendererInstanceId), {
        bootstrap: { ...(resumed ? renderer!.bootstrap : issued!.bootstrap) }, httpSession })
      if (this.rendererHeads.size > 1024) this.rendererHeads.delete(this.rendererHeads.keys().next().value!)
      const previous = this.leases.get(frame.documentId)
      this.leases.set(frame.documentId, { generation: previous?.clientId === frame.clientId &&
        previous.rendererInstanceId === frame.rendererInstanceId && previous.sourceContentId === frame.sourceContentId &&
        previous.documentEpoch === frame.documentEpoch ? previous.generation : randomUUID(),
        clientId: frame.clientId, rendererInstanceId: frame.rendererInstanceId,
        sourceContentId: frame.sourceContentId!, documentEpoch: frame.documentEpoch!, httpSession })
    })
  }
  async disconnect(clientId: string): Promise<void> {
    await Promise.all([...this.leases].filter(([, lease]) => lease.clientId === clientId).map(([documentId]) =>
      this.detach(documentId, clientId)))
  }
  detach(documentId: string, clientId: string): Promise<void> {
    return this.lane(documentId, async () => {
      if (this.leases.get(documentId)?.clientId !== clientId) return
      this.leases.delete(documentId)
      this.options.documents.detach({ documentId: documentId as DocumentId, clientId: clientId as ClientId })
    })
  }
  /** Router invokes only after consuming the exact one-time approval. Renderer input cannot grant it. */
  reserve(frame: EditorRequestFrame, authorization: { inPlaceRewrite?: boolean } = {}): Promise<string> {
    return this.lane(frame.target.documentId, async () => {
      const { documentId, operationId, clientId } = frame.target
      const lease = this.owner(documentId, clientId)
      const status = await this.port(documentId).store.getStatus()
      if (frame.target.editorType !== this.options.drivers.require(documentId).document.editorType) {
        fail('OPERATION_NOT_AUTHORIZED', 'Request editor type does not match the hydrated document.')
      }
      if (!isWorkingCopyMutation(frame.command) || !frame.approval) fail('OPERATION_NOT_AUTHORIZED', 'A working-copy mutation requires exact approval.')
      if (authorization.inPlaceRewrite && (frame.target.editorType !== 'pdf' || frame.command !== 'apply_ops')) {
        fail('OPERATION_NOT_AUTHORIZED', 'Only the approved PDF page rewrite may promote an apply operation.')
      }
      const requestFingerprint = operationRequestFingerprint({ documentId, documentEpoch: status.documentEpoch,
        editorType: frame.target.editorType, command: frame.command, arguments: frame.arguments, planHash: frame.approval!.planHash })
      const committed = await this.terminal(documentId, operationId, requestFingerprint)
      if (committed) return requestFingerprint
      this.options.documents.assertOwner({ documentId, clientId, revision: frame.target.revision })
      if (status.recoveryState !== 'ready') fail('REVISION_CONFLICT', 'The original file changed.')
      const key = this.key(documentId, operationId)
      const prior = this.reservations.get(key)
      if (prior) {
        if (prior.binding.requestFingerprint !== requestFingerprint) fail('OPERATION_ID_COLLISION', 'Operation identity changed.')
        this.assertLease(prior, clientId)
        return requestFingerprint
      }
      const binding: WorkingCopyOperationBinding = { requestFingerprint, planHash: frame.approval!.planHash,
        documentEpoch: status.documentEpoch, sourceContentId: lease.sourceContentId,
        fromWorkingRevision: status.workingRevision, fromSavedRevision: status.savedRevision, command: frame.command }
      this.reservations.set(key, { documentId, operationId, requestId: frame.id, lease: { ...lease }, binding,
        promote: frame.command.startsWith('save_') || authorization.inPlaceRewrite === true })
      return requestFingerprint
    })
  }
  private async terminal(documentId: string, operationId: string, fingerprint: string): Promise<WorkingCopyReceipt | undefined> {
    const store = this.port(documentId).store
    const binding = await store.lookupOperationBinding(operationId)
    const receipt = await store.lookupTerminal(operationId, fingerprint)
    if (receipt && !binding) fail('WORKING_COPY_RECOVERY_INVALID', 'A legacy receipt has no durable integration authorization binding.')
    return receipt
  }
  async lookup(documentId: string, clientId: string, input: { documentEpoch: string; operationId: string; requestFingerprint: string }): Promise<WorkingCopyLookup> {
    // Current document authorization is independent of the owner of the historical operation.
    this.options.documents.assertClient(documentId as DocumentId, clientId as ClientId)
    const status = await this.port(documentId).store.getStatus()
    if (status.documentEpoch !== input.documentEpoch) fail('REVISION_CONFLICT', 'Document epoch changed.')
    const receipt = await this.terminal(documentId, input.operationId, input.requestFingerprint)
    if (receipt) return { state: 'committed', persistence: persistenceReference(receipt), result: receipt.result }
    const pending = this.reservations.get(this.key(documentId, input.operationId))
    if (pending && pending.binding.requestFingerprint !== input.requestFingerprint) fail('OPERATION_ID_COLLISION', 'Operation identity changed.')
    return { state: pending ? 'pending' : 'not-found' }
  }
  async lookupRequest(frame: EditorRequestFrame): Promise<WorkingCopyLookup | undefined> {
    const store = this.port(frame.target.documentId).store
    const binding = await store.lookupOperationBinding(frame.target.operationId)
    if (!binding) return undefined
    const fingerprint = operationRequestFingerprint({ documentId: frame.target.documentId, documentEpoch: binding.documentEpoch,
      editorType: frame.target.editorType, command: frame.command, arguments: frame.arguments, planHash: frame.approval?.planHash ?? binding.planHash })
    return this.lookup(frame.target.documentId, frame.target.clientId, {
      documentEpoch: binding.documentEpoch, operationId: frame.target.operationId, requestFingerprint: fingerprint })
  }
  beginUpload(documentId: string, clientId: string, raw: CheckpointMetadata): Promise<{ uploadId: string; requestFingerprint: string }> {
    const metadata = checkpointMetadataSchema.parse(copy(raw))
    return this.lane(documentId, async () => {
      const lease = this.owner(documentId, clientId)
      if (metadata.clientId !== clientId) fail('WORKING_COPY_STALE_OWNER', 'HTTP and websocket client identities differ.')
      let reservation = this.reservations.get(this.key(documentId, metadata.operationId))
      if (!reservation) {
        const binding = await this.port(documentId).store.lookupOperationBinding(metadata.operationId)
        if (!binding || binding.planHash !== metadata.planHash || binding.documentEpoch !== metadata.documentEpoch ||
            binding.sourceContentId !== metadata.sourceContentId) fail('OPERATION_NOT_AUTHORIZED', 'No Host reservation authorizes this upload.')
        await this.terminal(documentId, metadata.operationId, binding!.requestFingerprint)
        reservation = { documentId, operationId: metadata.operationId, requestId: metadata.requestId, lease, binding: binding!,
          promote: false }
      } else {
        this.assertLease(reservation, clientId)
        const binding = reservation.binding
        if (reservation.requestId !== metadata.requestId || binding.documentEpoch !== metadata.documentEpoch ||
            binding.sourceContentId !== metadata.sourceContentId || binding.planHash !== metadata.planHash ||
            binding.fromWorkingRevision !== metadata.expectedWorkingRevision || binding.fromSavedRevision !== metadata.expectedSavedRevision) {
          fail('OPERATION_ID_COLLISION', 'Upload metadata does not match the approved reservation.')
        }
      }
      const expectedKind: Record<string, CheckpointPayloadKind> = { docs: 'docx-bytes', sheets: 'xlsx-save-plan', pdf: 'pdf-save-plan' }
      if (expectedKind[this.options.drivers.require(documentId).document.editorType] !== metadata.payloadKind) fail('WORKING_COPY_INVALID_CHECKPOINT', 'Wrong format payload.')
      const uploadId = await this.uploads.create({ reservation: copy(reservation), metadata })
      return { uploadId, requestFingerprint: reservation.binding.requestFingerprint }
    })
  }
  beginManualUpload(documentId: string, clientId: string, raw: ManualSaveMetadata): Promise<{ uploadId: string; operationId: string; requestFingerprint: string }> {
    const parsed = manualSaveMetadataSchema.parse(raw)
    // The browser supplies an idempotency key; only the Host creates the external Save identity.
    const input = { ...parsed, operationId: 'manual-' + hash(canonicalOperationJson([documentId, parsed.documentEpoch, parsed.operationId])) }
    return this.lane(documentId, async () => {
      const lease = this.owner(documentId, clientId)
      if (lease.documentEpoch !== input.documentEpoch || lease.sourceContentId !== input.sourceContentId) {
        fail('REVISION_CONFLICT', 'Manual Save requires the active renderer source.')
      }
      const binding: WorkingCopyOperationBinding = { documentEpoch: input.documentEpoch, sourceContentId: input.sourceContentId,
        fromWorkingRevision: input.expectedWorkingRevision, fromSavedRevision: input.expectedSavedRevision,
        command: 'manual_save', planHash: input.snapshotHash, requestFingerprint: hash(canonicalOperationJson({
          documentId, documentEpoch: input.documentEpoch, command: 'manual_save', planHash: input.snapshotHash })) }
      const key = this.key(documentId, input.operationId)
      const prior = this.reservations.get(key)
      if (prior && prior.binding.requestFingerprint !== binding.requestFingerprint) fail('OPERATION_ID_COLLISION', 'Manual Save snapshot changed.')
      const reservation: Reservation = { documentId, operationId: input.operationId, requestId: input.operationId, lease: { ...lease }, binding, promote: true }
      this.reservations.set(key, reservation)
      const metadata: CheckpointMetadata = { schemaVersion: 1, requestId: input.operationId, clientId,
        documentEpoch: input.documentEpoch, operationId: input.operationId, sourceContentId: input.sourceContentId,
        expectedWorkingRevision: input.expectedWorkingRevision, expectedSavedRevision: input.expectedSavedRevision,
        planHash: input.snapshotHash, payloadKind: input.payloadKind, result: { ok: true, summary: 'Saved document.', warnings: [] } }
      const uploadId = await this.uploads.create({ reservation, metadata })
      return { uploadId, operationId: input.operationId, requestFingerprint: binding.requestFingerprint }
    })
  }
  async putPart(documentId: string, clientId: string, uploadId: string, partId: string, stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<CheckpointPart> {
    const upload = await this.uploads.get(uploadId)
    if (upload.reservation.documentId !== documentId) fail('OPERATION_NOT_AUTHORIZED', 'Upload belongs to a different document.')
    this.assertLease(upload.reservation, clientId)
    return this.uploads.put(uploadId, partId, stream)
  }
  commitUpload(documentId: string, clientId: string, uploadId: string, parts: readonly CheckpointPart[]): Promise<Terminal> {
    return this.lane(documentId, async () => {
      const upload = this.completedUploads.get(uploadId) ?? await this.uploads.get(uploadId)
      const reservation = upload.reservation
      if (reservation.documentId !== documentId) fail('OPERATION_NOT_AUTHORIZED', 'Upload belongs to a different document.')
      this.options.documents.assertClient(documentId as DocumentId, clientId as ClientId)
      const prior = await this.terminal(documentId, reservation.operationId, reservation.binding.requestFingerprint)
      if (prior) return { persistence: persistenceReference(prior), result: prior.result }
      this.assertLease(reservation, clientId)
      const data = await this.uploads.readParts(uploadId, parts)
      let receipt: WorkingCopyReceipt
      try {
        receipt = await this.commit(reservation, upload.metadata, data)
      } catch (cause) {
        // No attempt is in flight after this lane's commit settles. Consult the durable ledger
        // before reclaiming only this upload; unknown durability keeps its evidence intact.
        let verified = false
        let recovered: WorkingCopyReceipt | undefined
        try {
          recovered = await this.terminal(documentId, reservation.operationId, reservation.binding.requestFingerprint)
          verified = true
        } catch { /* A recovery/conflict/fsync error remains an unknown outcome. */ }
        if (recovered) {
          receipt = recovered
          await this.refresh(documentId, true)
        } else {
          if (verified) await this.uploads.discard(uploadId).catch(() => undefined)
          const code = (cause as { code?: string })?.code
          if (code?.startsWith('WORKING_COPY_') || code === 'REVISION_CONFLICT' || code === 'OPERATION_ID_COLLISION') throw cause
          throw new WorkingCopyCoordinatorError('WORKING_COPY_PERSIST_FAILED', cause instanceof Error ? cause.message : 'Could not materialize this working copy.')
        }
      }
      this.completedUploads.set(uploadId, upload)
      if (this.completedUploads.size > 4096) this.completedUploads.delete(this.completedUploads.keys().next().value!)
      await this.uploads.discard(uploadId).catch(() => undefined)
      return { persistence: persistenceReference(receipt), result: receipt.result }
    })
  }
  private async commit(reservation: Reservation, metadata: CheckpointMetadata, parts: ReadonlyMap<string, Uint8Array>): Promise<WorkingCopyReceipt> {
    const { documentId, operationId, binding } = reservation
    const port = this.port(documentId)
    const status = await port.store.getStatus()
    if (status.documentEpoch !== binding.documentEpoch || status.recoveryState !== 'ready') fail('REVISION_CONFLICT', 'Working copy changed or requires recovery.')
    const preparationId = 'prepare-' + hash(this.key(documentId, operationId) + binding.requestFingerprint)
    const preparationFingerprint = hash('preparation:' + binding.requestFingerprint)
    const snapshotHash = hash(canonicalOperationJson([...parts].map(([id, bytes]) => [id, hash(bytes)]).sort()))
    if (binding.command === 'manual_save' && binding.planHash !== snapshotHash) fail('OPERATION_ID_COLLISION', 'Manual Save parts do not match the captured snapshot.')
    const prepared = reservation.promote ? await port.store.lookupTerminal(preparationId, preparationFingerprint) : undefined
    let checkpoint = prepared
    if (prepared && prepared.binding?.preparation?.snapshotHash !== snapshotHash) fail('OPERATION_ID_COLLISION', 'The approved save snapshot changed.')
    if (!prepared) {
      if (status.workingRevision !== binding.fromWorkingRevision || status.savedRevision !== binding.fromSavedRevision) {
        fail('REVISION_CONFLICT', 'The upload targets an earlier working or saved revision.')
      }
      const bytes = await port.materialize({ sourceContentId: binding.sourceContentId, payloadKind: metadata.payloadKind, parts })
      this.assertLease(reservation, reservation.lease.clientId)
      if (reservation.promote && status.head?.blobHash === hash(bytes)) {
        checkpoint = await port.store.promoteWorkingCopy({ documentEpoch: binding.documentEpoch,
          expectedSavedRevision: status.savedRevision, expectedWorkingRevision: status.workingRevision,
          checkpointId: status.head.checkpointId, operationId, requestFingerprint: binding.requestFingerprint,
          planHash: binding.planHash, result: metadata.result, binding })
        await this.refresh(documentId, true)
        return checkpoint
      }
      checkpoint = await port.store.commitCheckpoint({ documentEpoch: binding.documentEpoch,
        expectedSavedRevision: status.savedRevision, expectedWorkingRevision: status.workingRevision,
        operationId: reservation.promote ? preparationId : operationId,
        requestFingerprint: reservation.promote ? preparationFingerprint : binding.requestFingerprint,
        planHash: binding.planHash, bytes, payloadByteLength: bytes.byteLength, payloadHash: hash(bytes), result: metadata.result,
        binding: reservation.promote ? { ...binding, requestFingerprint: preparationFingerprint,
          preparation: { parentOperationId: operationId, snapshotHash } } : binding })
    }
    if (reservation.promote) {
      checkpoint = await port.store.promoteWorkingCopy({ documentEpoch: binding.documentEpoch,
        expectedSavedRevision: checkpoint!.savedRevision, expectedWorkingRevision: checkpoint!.workingRevision,
        checkpointId: checkpoint!.checkpointId, operationId, requestFingerprint: binding.requestFingerprint,
        planHash: binding.planHash, result: metadata.result, binding })
    }
    await this.refresh(documentId, true)
    return checkpoint!
  }
  /** Called only for an explicit authenticated manual Save action, never a recovery timer. */
  saveManual(input: ManualWorkingCopySave): Promise<Terminal> {
    const parts = new Map([...input.parts].map(([key, value]) => [key, new Uint8Array(value)]))
    return this.lane(input.documentId, async () => {
      const lease = this.owner(input.documentId, input.clientId)
      if (lease.documentEpoch !== input.documentEpoch || lease.sourceContentId !== input.sourceContentId) fail('REVISION_CONFLICT', 'Manual save source changed.')
      const planHash = hash(canonicalOperationJson([...parts].map(([key, value]) => [key, hash(value)]).sort()))
      const binding: WorkingCopyOperationBinding = { documentEpoch: input.documentEpoch, sourceContentId: input.sourceContentId,
        fromWorkingRevision: input.expectedWorkingRevision, fromSavedRevision: input.expectedSavedRevision,
        command: 'manual_save', planHash, requestFingerprint: hash(canonicalOperationJson({
          documentId: input.documentId, documentEpoch: input.documentEpoch, command: 'manual_save', planHash })) }
      const prior = await this.terminal(input.documentId, input.operationId, binding.requestFingerprint)
      if (prior) return { persistence: persistenceReference(prior), result: prior.result }
      const result: AgentToolResult = { ok: true, summary: 'Saved document.', warnings: [] }
      const receipt = await this.commit({ documentId: input.documentId, operationId: input.operationId,
        requestId: input.operationId, binding, lease, promote: true }, {
        schemaVersion: 1, requestId: input.operationId, clientId: input.clientId, documentEpoch: input.documentEpoch,
        operationId: input.operationId, expectedWorkingRevision: input.expectedWorkingRevision,
        expectedSavedRevision: input.expectedSavedRevision, sourceContentId: input.sourceContentId,
        planHash, result, payloadKind: input.payloadKind,
      }, parts)
      return { persistence: persistenceReference(receipt), result: receipt.result }
    })
  }
  async close(): Promise<void> { await Promise.all(this.queues.values()); await this.uploads.close() }
}
