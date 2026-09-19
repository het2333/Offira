import type {
  AgentServerFrame,
  ClientFrame,
  ClientId,
  DocumentId,
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
}
