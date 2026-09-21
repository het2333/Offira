import { isDeepStrictEqual } from 'node:util'

import type {
  AgentToolResult,
  AgentServerFrame,
  ClientFrame,
  ClientId,
  DocumentId,
  EditorRequestFrame,
  EditorResponseFrame,
  MutationTarget,
  OperationId,
  RequestId,
  SessionId,
} from '@nexusdesk/protocol'
import type { RuntimeResponseFrame } from '@nexusdesk/runtime-host/protocol'
import {
  freezeOfficeTurnContext,
  officeTurnContextText,
  type OfficeEditorType,
  type OfficeSelection,
  type OfficeTurnContext,
} from '@nexusdesk/runtime-host/office-session-binding'

import { DocumentRegistry } from './document-registry'
import { HarnessSupervisor } from './harness-supervisor'
import { OperationStore } from './operation-store'
import { WorkingCopyCoordinator, isWorkingCopyMutation } from './working-copy-coordinator'

interface SessionOwner {
  clientId: ClientId
  documentId: DocumentId
}

interface NativeSessionOwner extends SessionOwner {
  hostId: string
}

export interface BindNativeSessionInput {
  hostId: string
  documentId: DocumentId
  clientId: ClientId
  cwd: string
  provider?: string
  model?: string
}

export interface PrepareNativeTurnInput {
  requestId: string
  sessionId: SessionId
  clientId: ClientId
  selection: OfficeSelection | unknown
}

export interface PreparedNativeTurn {
  requestId: string
  sessionId: SessionId
  context: OfficeTurnContext
  contextText: string
}

interface ApprovalOwner extends SessionOwner {
  sessionId: SessionId
  timer: NodeJS.Timeout
  planHash?: string
  operationId?: OperationId
  toolName?: string
}

interface EditorOperationOwner {
  clientId: ClientId
  requestId: RequestId
  target: MutationTarget
  command: string
  request: EditorRequestFrame
}

interface DeliveredEditorResult extends EditorOperationOwner {
  result: AgentToolResult
}

export interface AgentRouterOptions {
  supervisor: HarnessSupervisor
  documents: DocumentRegistry
  operations: OperationStore
  workingCopy?: WorkingCopyCoordinator
  sendToClient(clientId: ClientId, frame: AgentServerFrame): void
  onApprovalExpired?(clientId: ClientId, id: string): void
  approvalTimeoutMs?: number
}

/** Routes one runtime to authenticated browser/document owners. */
export class AgentRouter {
  private readonly sessions = new Map<SessionId, SessionOwner>()
  private readonly nativeSessions = new Map<SessionId, NativeSessionOwner>()
  private readonly approvals = new Map<string, ApprovalOwner>()
  private readonly grantedApprovals = new Map<string, Omit<ApprovalOwner, 'timer'>>()
  private readonly editorOperations = new Map<OperationId, EditorOperationOwner>()
  private readonly deliveredEditorResults = new Map<RequestId, DeliveredEditorResult>()
  private readonly offFrame: () => void
  private readonly offExit: () => void

  constructor(private readonly options: AgentRouterOptions) {
    this.offFrame = options.supervisor.onFrame((frame) => {
      void this.handleRuntimeFrame(frame)
    })
    this.offExit = options.supervisor.onExit((exit) => {
      const affected = new Set(exit.activeSessions)
      for (const [sessionId, owner] of this.sessions) {
        if (!affected.has(sessionId)) continue
        this.options.sendToClient(owner.clientId, {
          type: 'fatal',
          protocolVersion: 1,
          message: `Harness runtime exited during the turn (${String(exit.code ?? exit.signal)})`,
        })
        this.sessions.delete(sessionId)
      }
      this.clearApprovals()
    })
  }

  async bindNativeSession(input: BindNativeSessionInput): Promise<SessionId> {
    const document = this.options.documents.assertClient(input.documentId, input.clientId)
    if (!isNativeEditorType(document.editorType)) {
      throw new Error(`native Office Session binding does not support ${document.editorType}`)
    }
    const result = await this.options.supervisor.bindOfficeSession({
      hostId: input.hostId,
      documentId: input.documentId,
      clientId: input.clientId,
      editorType: document.editorType,
      revision: document.revision,
      cwd: input.cwd,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
    })
    const existing = this.sessions.get(result.sessionId)
    if (existing !== undefined && existing.documentId !== input.documentId) {
      throw new Error(`native session ${result.sessionId} is already bound to another document`)
    }
    const owner = { hostId: input.hostId, clientId: input.clientId, documentId: input.documentId }
    this.sessions.set(result.sessionId, owner)
    this.nativeSessions.set(result.sessionId, owner)
    return result.sessionId
  }

  assertNativeSessionOwner(sessionId: SessionId, clientId: ClientId): NativeSessionOwner {
    const owner = this.nativeSessions.get(sessionId)
    if (owner === undefined || owner.clientId !== clientId) {
      throw new Error(`client ${clientId} does not own native session ${sessionId}`)
    }
    this.options.documents.assertClient(owner.documentId, clientId)
    return owner
  }

  prepareNativeTurn(input: PrepareNativeTurnInput): PreparedNativeTurn {
    if (typeof input.requestId !== 'string' || input.requestId.length === 0 || input.requestId.length > 256) {
      throw new Error('Invalid native Office request identity.')
    }
    const owner = this.assertNativeSessionOwner(input.sessionId, input.clientId)
    const document = this.options.documents.assertClient(owner.documentId, input.clientId)
    if (!isNativeEditorType(document.editorType)) {
      throw new Error(`native Office Session binding does not support ${document.editorType}`)
    }
    const context = freezeOfficeTurnContext({
      hostId: owner.hostId,
      documentId: String(owner.documentId),
      editorType: document.editorType,
      revision: document.revision,
      selection: input.selection,
    })
    return Object.freeze({
      requestId: input.requestId,
      sessionId: input.sessionId,
      context,
      contextText: officeTurnContextText(context),
    })
  }

  expireNativeSessionApprovals(sessionId: SessionId, clientId: ClientId): void {
    this.assertNativeSessionOwner(sessionId, clientId)
    this.cancelSessionApprovals(sessionId, clientId)
  }

  handleClientFrame(frame: ClientFrame, clientId: ClientId): void | Promise<void> {
    if (frame.type === 'editor:register' && this.options.workingCopy?.enabled(frame.documentId)) {
      return this.recoverWorkingCopyOperations(frame.documentId, clientId)
    }
    if (frame.type === 'editor:result' && this.options.workingCopy?.enabled(frame.target.documentId)) {
      const pending = this.editorOperations.get(frame.target.operationId)
      if (pending && isWorkingCopyMutation(pending.command)) return this.handleWorkingCopyResult(frame, clientId)
    }
    if (frame.type === 'operation:lookup' && frame.documentId && this.options.workingCopy?.enabled(frame.documentId)) {
      return (async () => {
        if (!frame.documentEpoch || !frame.requestFingerprint) throw Error('Durable lookup requires its epoch and fingerprint.')
        const lookup = await this.options.workingCopy!.lookup(frame.documentId!, clientId, {
          documentEpoch: frame.documentEpoch, operationId: frame.operationId, requestFingerprint: frame.requestFingerprint,
        })
        this.options.sendToClient(clientId, { type: 'operation:result', protocolVersion: 1, id: frame.id,
          operationId: frame.operationId, state: lookup.state,
          ...(lookup.state === 'committed' ? { persistence: lookup.persistence } : {}),
          result: lookup.state === 'committed' ? lookup.result :
            { ok: false, summary: 'Operation outcome requires recovery.', warnings: [{ code: 'WORKING_COPY_OUTCOME_UNKNOWN', message: lookup.state }] } })
      })()
    }
    if (frame.type === 'editor:register') {
      for (const [operationId, operation] of this.editorOperations) {
        if (operation.target.documentId !== frame.documentId) continue
        if (this.options.operations.lookup(operationId)?.state !== 'reserved') continue
        const request: EditorRequestFrame = {
          ...operation.request,
          target: { ...operation.request.target, clientId },
        }
        operation.clientId = clientId
        operation.target = request.target
        operation.request = request
        const session = this.sessions.get(operation.target.sessionId)
        if (session !== undefined) session.clientId = clientId
        this.options.sendToClient(clientId, request)
      }
      return
    }
    if (frame.type === 'editor:revision') {
      this.expireApprovals(
        (approval) => approval.clientId === clientId && approval.documentId === frame.documentId,
      )
      this.expireGrantedApprovals(
        (approval) => approval.clientId === clientId && approval.documentId === frame.documentId,
      )
      return
    }
    if (frame.type === 'agent:start') {
      const existing = this.sessions.get(frame.sessionId)
      if (
        existing !== undefined &&
        (existing.clientId !== clientId || existing.documentId !== frame.documentId)
      ) {
        throw new Error(`client ${clientId} does not own session ${frame.sessionId}`)
      }
      const document = this.options.documents.assertClient(frame.documentId, clientId)
      this.sessions.set(frame.sessionId, { clientId, documentId: frame.documentId })
      this.options.supervisor.startTurn({
        sessionId: frame.sessionId,
        documentId: frame.documentId,
        clientId,
        editorType: document.editorType,
        revision: document.revision,
        cwd: process.cwd(),
        prompt: frame.prompt,
        ...(frame.provider === undefined ? {} : { provider: frame.provider }),
        ...(frame.model === undefined ? {} : { model: frame.model }),
      })
      return
    }
    if (frame.type === 'editor:result') {
      const owner = this.editorOperations.get(frame.target.operationId)
      if (
        owner === undefined ||
        owner.clientId !== clientId ||
        owner.requestId !== frame.id ||
        !sameTarget(owner.target, frame.target)
      ) {
        const delivered = this.deliveredEditorResults.get(frame.id)
        if (
          delivered !== undefined &&
          delivered.clientId === clientId &&
          delivered.requestId === frame.id &&
          sameTarget(delivered.target, frame.target) &&
          isDeepStrictEqual(delivered.result, frame.result)
        ) {
          return
        }
        throw new Error(`client ${clientId} does not own operation ${frame.target.operationId}`)
      }
      // routeEditorRequest already authenticated the exact target revision
      // before reserving the operation. A successful editor applies the
      // mutation and advances its revision before it can send this result, so
      // re-check ownership here without requiring the old revision to remain
      // current.
      const document = this.options.documents.assertClient(frame.target.documentId, clientId)
      if (!isProposalCommand(owner.command)) {
        if (frame.result.ok) this.options.operations.commit(frame.target.operationId, frame.result)
        else this.options.operations.fail(frame.target.operationId, frame.result)
      }
      this.deliveredEditorResults.set(frame.id, { ...owner, result: frame.result })
      this.editorOperations.delete(frame.target.operationId)
      this.options.supervisor.respondEditor({ ...frame, currentRevision: document.revision })
      return
    }
    if (frame.type === 'operation:lookup') {
      const owner = this.editorOperations.get(frame.operationId)
      if (owner === undefined) throw new Error(`operation ${frame.operationId} is not available`)
      this.options.documents.assertClient(owner.target.documentId, clientId)
      const record = this.options.operations.lookup(frame.operationId)
      if (record === undefined || record.state === 'reserved') {
        throw new Error(`operation ${frame.operationId} has no terminal result`)
      }
      this.options.sendToClient(clientId, {
        type: 'operation:result',
        protocolVersion: 1,
        id: frame.id,
        operationId: frame.operationId,
        result: record.result,
      })
      return
    }
    if (frame.type === 'agent:cancel') {
      this.assertSessionOwner(frame.sessionId, clientId)
      this.cancelSessionApprovals(frame.sessionId, clientId)
      this.options.supervisor.cancelTurn(frame.sessionId)
      return
    }
    if (frame.type === 'approval:response') {
      const approval = this.approvals.get(frame.id)
      if (approval === undefined || approval.clientId !== clientId) {
        throw new Error(`client ${clientId} does not own approval ${frame.id}`)
      }
      clearTimeout(approval.timer)
      this.approvals.delete(frame.id)
      if (frame.outcome === 'allowed-once' && approval.planHash !== undefined) {
        const { timer: _timer, ...granted } = approval
        this.grantedApprovals.set(frame.id, granted)
      }
      if (frame.outcome !== 'allowed-once') this.releaseProposal(approval, frame.outcome)
      this.options.supervisor.respondApproval(frame.id, frame.outcome)
    }
  }

  routeRuntimeFrame(frame: RuntimeResponseFrame): void | Promise<void> {
    if (frame.type === 'agent:event') {
      const owner = this.sessions.get(frame.sessionId)
      if (owner !== undefined) this.options.sendToClient(owner.clientId, frame)
      return
    }
    if (frame.type === 'approval:request') {
      const owner = this.sessions.get(frame.sessionId)
      if (owner === undefined) {
        this.options.supervisor.respondApproval(frame.id, 'unavailable')
        return
      }
      const replay =
        frame.proposal?.operationId === undefined
          ? undefined
          : this.options.operations.lookup(frame.proposal.operationId as OperationId)
      if (replay !== undefined && replay.state !== 'reserved') {
        this.options.supervisor.respondApproval(frame.id, 'allowed-once')
        return
      }
      const timer = setTimeout(() => {
        const expired = this.approvals.get(frame.id)
        this.approvals.delete(frame.id)
        if (expired) {
          this.options.onApprovalExpired?.(expired.clientId, frame.id)
          this.releaseProposal(expired, 'unavailable')
        }
        this.options.supervisor.respondApproval(frame.id, 'unavailable')
      }, this.options.approvalTimeoutMs ?? 120_000)
      this.approvals.set(frame.id, {
        ...owner,
        sessionId: frame.sessionId,
        timer,
        toolName: frame.toolName,
        ...(frame.proposal === undefined ? {} : { planHash: frame.proposal.planHash }),
        ...(frame.proposal?.operationId === undefined
          ? {}
          : { operationId: frame.proposal.operationId as OperationId }),
      })
      this.options.sendToClient(owner.clientId, frame as AgentServerFrame)
      return
    }
    if (frame.type === 'editor:request') {
      if (this.options.workingCopy?.enabled(frame.target.documentId) && isWorkingCopyMutation(frame.command)) {
        return this.routeWorkingCopyRequest(frame)
      }
      this.routeEditorRequest(frame)
    }
  }

  hasApproval(id: string): boolean {
    return this.approvals.has(id)
  }

  async handleRuntimeFrame(frame: RuntimeResponseFrame): Promise<void> {
    try { await this.routeRuntimeFrame(frame) } catch (error) {
      try { this.rejectRuntimeFrame(frame, error) } catch {
        // A failed delivery remains in editorOperations, or in the durable ledger for later lookup.
      }
    }
  }

  async notifyWorkingCopyCommit(documentId: string, operationId: string): Promise<void> {
    const owner = this.editorOperations.get(operationId as OperationId)
    if (!owner || owner.target.documentId !== documentId || !this.options.workingCopy) return
    const terminal = await this.options.workingCopy.lookupRequest(owner.request)
    if (terminal?.state === 'committed') this.deliverWorkingCopy(owner, terminal)
  }

  disconnectClient(clientId: ClientId): void {
    const uncertainSessions = new Set(
      [...this.editorOperations.values()]
        .filter(
          (operation) =>
            operation.clientId === clientId &&
            this.options.operations.lookup(operation.target.operationId)?.state === 'reserved',
        )
        .map((operation) => operation.target.sessionId),
    )
    for (const [sessionId, owner] of this.sessions) {
      if (owner.clientId !== clientId) continue
      if (uncertainSessions.has(sessionId)) continue
      this.options.supervisor.cancelTurn(sessionId)
      this.sessions.delete(sessionId)
    }
    for (const [id, approval] of this.approvals) {
      if (approval.clientId !== clientId) continue
      clearTimeout(approval.timer)
      this.approvals.delete(id)
      this.options.onApprovalExpired?.(approval.clientId, id)
      this.options.supervisor.respondApproval(id, 'unavailable')
    }
    this.expireGrantedApprovals((approval) => approval.clientId === clientId)
  }

  dispose(): void {
    this.offFrame()
    this.offExit()
    this.clearApprovals()
    this.grantedApprovals.clear()
    this.deliveredEditorResults.clear()
    this.nativeSessions.clear()
  }

  private assertSessionOwner(sessionId: SessionId, clientId: ClientId): SessionOwner {
    const owner = this.sessions.get(sessionId)
    if (owner === undefined || owner.clientId !== clientId) {
      throw new Error(`client ${clientId} does not own session ${sessionId}`)
    }
    return owner
  }

  private async routeWorkingCopyRequest(frame: EditorRequestFrame): Promise<void> {
    const owner = this.assertSessionOwner(frame.target.sessionId, frame.target.clientId)
    if (owner.documentId !== frame.target.documentId) throw Error('Runtime request does not match its document.')
    this.options.documents.assertClient(frame.target.documentId, owner.clientId)
    // Durable replay precedes target revision checks; a historical receipt must never move the head back.
    const replay = await this.options.workingCopy!.lookupRequest(frame)
    if (replay?.state === 'committed') {
      this.options.supervisor.respondEditor({ type: 'editor:result', protocolVersion: 1, id: frame.id,
        target: frame.target, result: replay.result, persistence: replay.persistence,
        currentRevision: this.options.documents.assertClient(frame.target.documentId, owner.clientId).revision })
      return
    }
    this.options.documents.assertOwner({ documentId: frame.target.documentId, clientId: owner.clientId, revision: frame.target.revision })
    const authorization = frame.approval
    const granted = authorization && this.grantedApprovals.get(authorization.id)
    if (!authorization || !granted || granted.sessionId !== frame.target.sessionId ||
        granted.documentId !== frame.target.documentId || granted.clientId !== frame.target.clientId ||
        granted.planHash !== authorization.planHash ||
        (granted.operationId !== undefined && granted.operationId !== frame.target.operationId)) {
      throw Error('Working-copy mutation has no matching one-time approval.')
    }
    this.grantedApprovals.delete(authorization.id)
    const fingerprint = await this.options.workingCopy!.reserve(frame, { inPlaceRewrite: granted.toolName === 'modify_pdf_pages' })
    this.options.operations.reserve(frame.target.operationId, { requestFingerprint: fingerprint })
    this.editorOperations.set(frame.target.operationId, { clientId: owner.clientId, requestId: frame.id,
      target: frame.target, command: frame.command, request: frame })
    this.options.sendToClient(owner.clientId, frame)
  }

  private async handleWorkingCopyResult(frame: EditorResponseFrame, clientId: ClientId): Promise<void> {
    const owner = this.editorOperations.get(frame.target.operationId)
    if (!owner || owner.clientId !== clientId || owner.requestId !== frame.id || !sameTarget(owner.target, frame.target)) {
      throw Error('Renderer does not own this operation result.')
    }
    this.options.documents.assertClient(frame.target.documentId, clientId)
    // A lookup failure is uncertainty, not a failed mutation terminal. A renderer may report
    // failure after losing the acknowledgement of an already committed checkpoint.
    const committed = await this.options.workingCopy!.lookupRequest(owner.request).catch(() => undefined)
    // lookupRequest verifies this reservation's identity; renderer data cannot veto its durable terminal.
    if (committed?.state === 'committed') {
      this.deliverWorkingCopy(owner, committed)
      return
    }
    const message = 'No verified durable terminal matches this result. Preserve the operation and query its outcome; do not repeat the mutation.'
    // Finish the runtime request promptly without ending the reservation or recovery lookup.
    // Deliver before the browser notification, whose transport may already be disconnected.
    this.options.supervisor.respondEditor({ type: 'editor:result', protocolVersion: 1, id: owner.requestId,
      target: owner.target, currentRevision: this.options.documents.assertClient(owner.target.documentId, clientId).revision,
      result: { ok: false, summary: 'Working-copy outcome is unknown; recovery is required.',
        warnings: [{ code: 'WORKING_COPY_OUTCOME_UNKNOWN', message }] } })
    this.options.sendToClient(clientId, { type: 'recovery:required', protocolVersion: 1, id: frame.id,
      documentId: frame.target.documentId, code: 'WORKING_COPY_OUTCOME_UNKNOWN', message })
  }

  private deliverWorkingCopy(owner: EditorOperationOwner, committed: Extract<Awaited<ReturnType<WorkingCopyCoordinator['lookup']>>, { state: 'committed' }>): void {
    if (this.options.operations.lookup(owner.target.operationId)?.state === 'reserved') {
      this.options.operations.commit(owner.target.operationId, committed.result)
    }
    this.options.supervisor.respondEditor({ type: 'editor:result', protocolVersion: 1, id: owner.requestId,
      target: owner.target, result: committed.result, persistence: committed.persistence,
      currentRevision: this.options.documents.assertClient(owner.target.documentId, owner.clientId).revision })
    // A failed transport leaves the pending delivery intact. The Store remains the authority.
    this.deliveredEditorResults.set(owner.requestId, { ...owner, result: committed.result })
    this.editorOperations.delete(owner.target.operationId)
  }

  private async recoverWorkingCopyOperations(documentId: DocumentId, clientId: ClientId): Promise<void> {
    for (const operation of this.editorOperations.values()) {
      if (operation.target.documentId !== documentId || !isWorkingCopyMutation(operation.command)) continue
      operation.clientId = clientId
      operation.target = { ...operation.target, clientId }
      operation.request = { ...operation.request, target: operation.target }
      const session = this.sessions.get(operation.target.sessionId)
      if (session) session.clientId = clientId
      const terminal = await this.options.workingCopy!.lookupRequest(operation.request)
      if (terminal?.state === 'committed') this.deliverWorkingCopy(operation, terminal)
      else {
        this.options.supervisor.respondEditor({ type: 'editor:result', protocolVersion: 1, id: operation.requestId,
          target: operation.target, currentRevision: this.options.documents.assertClient(documentId, clientId).revision,
          result: { ok: false, summary: 'The previous renderer did not publish a verified checkpoint. Restore and propose again.',
            warnings: [{ code: 'WORKING_COPY_RECOVERY_REQUIRED', message: 'Do not replay the previous mutation.' }] } })
      }
    }
  }

  private clearApprovals(): void {
    for (const [id, approval] of this.approvals) {
      clearTimeout(approval.timer)
      this.options.onApprovalExpired?.(approval.clientId, id)
    }
    this.approvals.clear()
  }

  private cancelSessionApprovals(sessionId: SessionId, clientId: ClientId): void {
    for (const operation of this.editorOperations.values()) {
      if (operation.target.sessionId === sessionId && isProposalCommand(operation.command))
        this.releaseProposal(
          { clientId, sessionId, operationId: operation.target.operationId },
          'cancelled',
        )
    }
    this.expireApprovals((approval) => approval.sessionId === sessionId)
    this.expireGrantedApprovals((approval) => approval.sessionId === sessionId)
  }

  private releaseProposal(
    owner: { clientId: ClientId; sessionId: SessionId; operationId?: OperationId },
    outcome: string,
  ): void {
    if (owner.operationId === undefined) return
    try {
      this.options.sendToClient(owner.clientId, {
        type: 'agent:event',
        protocolVersion: 1,
        sessionId: owner.sessionId,
        event: {
          type: 'editor:proposal-released',
          data: { operationId: owner.operationId, outcome },
        },
      })
    } catch {
      /* Offline renderers still release their proposals through the absolute TTL. */
    }
  }

  private expireApprovals(predicate: (approval: ApprovalOwner) => boolean): void {
    for (const [id, approval] of this.approvals) {
      if (!predicate(approval)) continue
      clearTimeout(approval.timer)
      this.approvals.delete(id)
      this.options.onApprovalExpired?.(approval.clientId, id)
      this.releaseProposal(approval, 'unavailable')
      this.options.supervisor.respondApproval(id, 'unavailable')
    }
  }

  private expireGrantedApprovals(
    predicate: (approval: Omit<ApprovalOwner, 'timer'>) => boolean,
  ): void {
    for (const [id, approval] of this.grantedApprovals) {
      if (predicate(approval)) {
        this.grantedApprovals.delete(id)
        this.releaseProposal(approval, 'unavailable')
      }
    }
  }

  private routeEditorRequest(frame: EditorRequestFrame): void {
    const owner = this.sessions.get(frame.target.sessionId)
    if (
      owner === undefined ||
      owner.clientId !== frame.target.clientId ||
      owner.documentId !== frame.target.documentId
    ) {
      throw new Error(`runtime request ${frame.id} does not match its agent session`)
    }
    this.options.documents.assertOwner({
      documentId: frame.target.documentId,
      clientId: owner.clientId,
      revision: frame.target.revision,
    })
    if (isProposalCommand(frame.command)) {
      // A complete tool retry must keep the original snapshot, even if saving
      // advanced the document revision or the user has since edited again.
      const terminal = this.options.operations.lookup(frame.target.operationId)
      if (terminal !== undefined && terminal.state !== 'reserved') {
        const proposal = [...this.deliveredEditorResults.values()].find(
          (result) =>
            result.target.operationId === frame.target.operationId &&
            isProposalCommand(result.command),
        )
        if (
          proposal === undefined ||
          proposal.command !== frame.command ||
          proposal.target.documentId !== frame.target.documentId ||
          proposal.target.editorType !== frame.target.editorType ||
          !isDeepStrictEqual(proposal.request.arguments, frame.arguments)
        )
          throw new Error('operation proposal is unavailable or bound to a different payload')
        this.options.supervisor.respondEditor({
          type: 'editor:result',
          protocolVersion: 1,
          id: frame.id,
          target: frame.target,
          result: proposal.result,
          currentRevision: this.options.documents.assertClient(
            frame.target.documentId,
            owner.clientId,
          ).revision,
        })
        return
      }
      this.editorOperations.set(frame.target.operationId, {
        clientId: owner.clientId,
        requestId: frame.id,
        target: frame.target,
        command: frame.command,
        request: frame,
      })
      this.options.sendToClient(owner.clientId, frame)
      return
    }
    const operationPayload = {
      documentId: frame.target.documentId,
      editorType: frame.target.editorType,
      command: frame.command,
      arguments: frame.arguments,
    }
    const existing = this.options.operations.lookup(frame.target.operationId)
    if (existing !== undefined) {
      const replay = this.options.operations.reserve(frame.target.operationId, operationPayload)
      if (replay.state !== 'reserved') {
        this.editorOperations.set(frame.target.operationId, {
          clientId: owner.clientId,
          requestId: frame.id,
          target: frame.target,
          command: frame.command,
          request: frame,
        })
        this.options.supervisor.respondEditor({
          type: 'editor:result',
          protocolVersion: 1,
          id: frame.id,
          target: frame.target,
          result: replay.result,
          currentRevision: this.options.documents.assertClient(
            frame.target.documentId,
            owner.clientId,
          ).revision,
        })
        return
      }
    }
    if (
      frame.command === 'apply_ops' ||
      frame.command === 'apply_history' ||
      frame.command === 'save_sheet' ||
      frame.command === 'save_document' ||
      frame.command === 'save_presentation' ||
      frame.command === 'save_pdf' ||
      frame.command === 'save_markdown' ||
      frame.command === 'save_html'
    ) {
      const authorization = frame.approval
      if (authorization === undefined) {
        throw new Error(`runtime request ${frame.id} has no matching one-time approval`)
      }
      const granted = this.grantedApprovals.get(authorization.id)
      if (
        granted === undefined ||
        granted.sessionId !== frame.target.sessionId ||
        granted.documentId !== frame.target.documentId ||
        granted.clientId !== frame.target.clientId ||
        granted.planHash !== authorization.planHash ||
        (granted.operationId !== undefined && granted.operationId !== frame.target.operationId)
      ) {
        throw new Error(`runtime request ${frame.id} has no matching one-time approval`)
      }
      this.grantedApprovals.delete(authorization.id)
    }
    this.editorOperations.set(frame.target.operationId, {
      clientId: owner.clientId,
      requestId: frame.id,
      target: frame.target,
      command: frame.command,
      request: frame,
    })
    const record = this.options.operations.reserve(frame.target.operationId, operationPayload)
    if (record.state !== 'reserved') {
      this.options.supervisor.respondEditor({
        type: 'editor:result',
        protocolVersion: 1,
        id: frame.id,
        target: frame.target,
        result: record.result,
        currentRevision: this.options.documents.assertClient(
          frame.target.documentId,
          owner.clientId,
        ).revision,
      })
      return
    }
    this.options.sendToClient(owner.clientId, frame)
  }

  private rejectRuntimeFrame(frame: RuntimeResponseFrame, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (frame.type === 'editor:request') {
      let currentRevision = frame.target.revision
      try {
        currentRevision = this.options.documents.assertClient(
          frame.target.documentId,
          frame.target.clientId,
        ).revision
      } catch {
        // The terminal failure remains bound to the runtime's exact request.
      }
      this.options.supervisor.respondEditor({
        type: 'editor:result',
        protocolVersion: 1,
        id: frame.id,
        target: frame.target,
        currentRevision,
        result: {
          ok: false,
          summary: message,
          warnings: [{ code: 'EDITOR_ROUTE_REJECTED', message }],
        },
      })
      return
    }
    if (frame.type === 'approval:request') {
      this.options.supervisor.respondApproval(frame.id, 'unavailable')
    }
  }
}

function isNativeEditorType(editorType: string): editorType is OfficeEditorType {
  return editorType === 'sheets' || editorType === 'docs' || editorType === 'slides'
}

function sameTarget(left: MutationTarget, right: MutationTarget): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.documentId === right.documentId &&
    left.editorType === right.editorType &&
    left.revision === right.revision &&
    left.operationId === right.operationId &&
    left.clientId === right.clientId
  )
}

function isProposalCommand(command: string): boolean {
  return command === 'propose_ops' || command === 'propose_save' || command === 'propose_history'
}
