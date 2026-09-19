import type {
  AgentServerFrame,
  ClientFrame,
  ClientId,
  DocumentId,
  EditorRequestFrame,
  MutationTarget,
  OperationId,
  RequestId,
  SessionId,
} from '@nexusdesk/protocol'
import type { RuntimeResponseFrame } from '@nexusdesk/runtime-host/protocol'

import { DocumentRegistry } from './document-registry'
import { HarnessSupervisor } from './harness-supervisor'
import { OperationStore } from './operation-store'

interface SessionOwner {
  clientId: ClientId
  documentId: DocumentId
}

interface ApprovalOwner extends SessionOwner {
  sessionId: SessionId
  timer: NodeJS.Timeout
  planHash?: string
}

interface EditorOperationOwner {
  clientId: ClientId
  requestId: RequestId
  target: MutationTarget
  command: string
  request: EditorRequestFrame
}

export interface AgentRouterOptions {
  supervisor: HarnessSupervisor
  documents: DocumentRegistry
  operations: OperationStore
  sendToClient(clientId: ClientId, frame: AgentServerFrame): void
  approvalTimeoutMs?: number
}

/** Routes one runtime to authenticated browser/document owners. */
export class AgentRouter {
  private readonly sessions = new Map<SessionId, SessionOwner>()
  private readonly approvals = new Map<string, ApprovalOwner>()
  private readonly grantedApprovals = new Map<string, Omit<ApprovalOwner, 'timer'>>()
  private readonly editorOperations = new Map<OperationId, EditorOperationOwner>()
  private readonly offFrame: () => void
  private readonly offExit: () => void

  constructor(private readonly options: AgentRouterOptions) {
    this.offFrame = options.supervisor.onFrame((frame) => {
      try {
        this.routeRuntimeFrame(frame)
      } catch (error: unknown) {
        this.rejectRuntimeFrame(frame, error)
      }
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

  handleClientFrame(frame: ClientFrame, clientId: ClientId): void {
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
        throw new Error(`client ${clientId} does not own operation ${frame.target.operationId}`)
      }
      // routeEditorRequest already authenticated the exact target revision
      // before reserving the operation. A successful editor applies the
      // mutation and advances its revision before it can send this result, so
      // re-check ownership here without requiring the old revision to remain
      // current.
      const document = this.options.documents.assertClient(frame.target.documentId, clientId)
      if (owner.command !== 'propose_ops') {
        if (frame.result.ok) this.options.operations.commit(frame.target.operationId, frame.result)
        else this.options.operations.fail(frame.target.operationId, frame.result)
      }
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
      this.options.supervisor.respondApproval(frame.id, frame.outcome)
    }
  }

  routeRuntimeFrame(frame: RuntimeResponseFrame): void {
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
      const timer = setTimeout(() => {
        this.approvals.delete(frame.id)
        this.options.supervisor.respondApproval(frame.id, 'unavailable')
      }, this.options.approvalTimeoutMs ?? 120_000)
      this.approvals.set(frame.id, {
        ...owner,
        sessionId: frame.sessionId,
        timer,
        ...(frame.proposal === undefined ? {} : { planHash: frame.proposal.planHash }),
      })
      this.options.sendToClient(owner.clientId, frame as AgentServerFrame)
      return
    }
    if (frame.type === 'editor:request') {
      this.routeEditorRequest(frame)
    }
  }

  hasApproval(id: string): boolean {
    return this.approvals.has(id)
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
      this.options.supervisor.respondApproval(id, 'unavailable')
    }
    this.expireGrantedApprovals((approval) => approval.clientId === clientId)
  }

  dispose(): void {
    this.offFrame()
    this.offExit()
    this.clearApprovals()
    this.grantedApprovals.clear()
  }

  private assertSessionOwner(sessionId: SessionId, clientId: ClientId): SessionOwner {
    const owner = this.sessions.get(sessionId)
    if (owner === undefined || owner.clientId !== clientId) {
      throw new Error(`client ${clientId} does not own session ${sessionId}`)
    }
    return owner
  }

  private clearApprovals(): void {
    for (const approval of this.approvals.values()) clearTimeout(approval.timer)
    this.approvals.clear()
  }

  private expireApprovals(predicate: (approval: ApprovalOwner) => boolean): void {
    for (const [id, approval] of this.approvals) {
      if (!predicate(approval)) continue
      clearTimeout(approval.timer)
      this.approvals.delete(id)
      this.options.supervisor.respondApproval(id, 'unavailable')
    }
  }

  private expireGrantedApprovals(
    predicate: (approval: Omit<ApprovalOwner, 'timer'>) => boolean,
  ): void {
    for (const [id, approval] of this.grantedApprovals) {
      if (predicate(approval)) this.grantedApprovals.delete(id)
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
    if (frame.command === 'apply_ops' || frame.command === 'save_sheet') {
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
        granted.planHash !== authorization.planHash
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
    if (frame.command === 'propose_ops') {
      this.options.sendToClient(owner.clientId, frame)
      return
    }
    const record = this.options.operations.reserve(frame.target.operationId, {
      documentId: frame.target.documentId,
      editorType: frame.target.editorType,
      command: frame.command,
      arguments: frame.arguments,
    })
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
