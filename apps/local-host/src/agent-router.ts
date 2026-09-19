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
}

interface EditorOperationOwner {
  clientId: ClientId
  requestId: RequestId
  target: MutationTarget
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
  private readonly editorOperations = new Map<OperationId, EditorOperationOwner>()
  private readonly offFrame: () => void
  private readonly offExit: () => void

  constructor(private readonly options: AgentRouterOptions) {
    this.offFrame = options.supervisor.onFrame((frame) => this.routeRuntimeFrame(frame))
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
    if (frame.type === 'editor:revision') {
      this.expireApprovals((approval) => approval.clientId === clientId
        && approval.documentId === frame.documentId)
      return
    }
    if (frame.type === 'agent:start') {
      const existing = this.sessions.get(frame.sessionId)
      if (existing !== undefined
        && (existing.clientId !== clientId || existing.documentId !== frame.documentId)) {
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
      if (owner === undefined
        || owner.clientId !== clientId
        || owner.requestId !== frame.id
        || !sameTarget(owner.target, frame.target)) {
        throw new Error(`client ${clientId} does not own operation ${frame.target.operationId}`)
      }
      this.options.documents.assertOwner({
        documentId: frame.target.documentId,
        clientId,
        revision: frame.target.revision,
      })
      if (frame.result.ok) this.options.operations.commit(frame.target.operationId, frame.result)
      else this.options.operations.fail(frame.target.operationId, frame.result)
      this.options.supervisor.respondEditor(frame)
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
      this.approvals.set(frame.id, { ...owner, sessionId: frame.sessionId, timer })
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
    for (const [sessionId, owner] of this.sessions) {
      if (owner.clientId !== clientId) continue
      this.options.supervisor.cancelTurn(sessionId)
      this.sessions.delete(sessionId)
    }
    for (const [id, approval] of this.approvals) {
      if (approval.clientId !== clientId) continue
      clearTimeout(approval.timer)
      this.approvals.delete(id)
      this.options.supervisor.respondApproval(id, 'unavailable')
    }
  }

  dispose(): void {
    this.offFrame()
    this.offExit()
    this.clearApprovals()
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

  private routeEditorRequest(frame: EditorRequestFrame): void {
    const owner = this.sessions.get(frame.target.sessionId)
    if (owner === undefined
      || owner.clientId !== frame.target.clientId
      || owner.documentId !== frame.target.documentId) {
      throw new Error(`runtime request ${frame.id} does not match its agent session`)
    }
    this.options.documents.assertOwner({
      documentId: frame.target.documentId,
      clientId: owner.clientId,
      revision: frame.target.revision,
    })
    const record = this.options.operations.reserve(frame.target.operationId, {
      target: frame.target,
      command: frame.command,
      arguments: frame.arguments,
    })
    this.editorOperations.set(frame.target.operationId, {
      clientId: owner.clientId,
      requestId: frame.id,
      target: frame.target,
    })
    if (record.state !== 'reserved') {
      this.options.supervisor.respondEditor({
        type: 'editor:result',
        protocolVersion: 1,
        id: frame.id,
        target: frame.target,
        result: record.result,
      })
      return
    }
    this.options.sendToClient(owner.clientId, frame)
  }
}

function sameTarget(left: MutationTarget, right: MutationTarget): boolean {
  return left.sessionId === right.sessionId
    && left.documentId === right.documentId
    && left.editorType === right.editorType
    && left.revision === right.revision
    && left.operationId === right.operationId
    && left.clientId === right.clientId
}
