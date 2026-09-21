import { randomUUID } from 'node:crypto'
import type { ApprovalOutcome, ApprovalRequestFrame, ClientId, DocumentId, HarnessClientFrame, HarnessServerFrame, RequestId, SessionId } from '@nexusdesk/protocol'
import type { RuntimeRequestFrame, RuntimeResponseFrame } from '@nexusdesk/runtime-host/protocol'
import type { AgentRouter } from './agent-router'

interface Binding {
  clientId: ClientId; documentId: DocumentId; sessionId: SessionId
  pending: Map<RequestId, string | false>
  prepared: Map<string, { revision: number; selection: unknown }>
  eventStream?: { id: RequestId; token: string }
  approvals: Map<string, RequestId>
}
interface Options {
  router: Pick<AgentRouter, 'bindNativeSession' | 'assertNativeSessionOwner' | 'prepareNativeTurn' | 'expireNativeSessionApprovals'>
  hostId: string
  cwd: string
  answerApproval?(id: RequestId, outcome: ApprovalOutcome, clientId: ClientId): void | Promise<void>
  send(clientId: ClientId, frame: HarnessServerFrame): void
  forward(frame: Extract<RuntimeRequestFrame, { type: 'office:client' | 'office:detach' }>): void
}

/** Authenticated socket admissions only. Identity and cwd never come from the browser. */
export class NativeOfficeCarrier {
  private readonly bindings = new Map<string, Binding>()
  constructor(private readonly options: Options) {}
  private key(clientId: ClientId, documentId: DocumentId): string { return JSON.stringify([clientId, documentId]) }

  assertBound(clientId: ClientId, documentId: DocumentId): SessionId {
    const binding = this.bindings.get(this.key(clientId, documentId))
    if (!binding) throw new Error('Office document is not bound.')
    const owner = this.options.router.assertNativeSessionOwner(binding.sessionId, clientId)
    if (owner.documentId !== documentId) throw new Error('Office document ownership mismatch.')
    return binding.sessionId
  }

  async handle(frame: HarnessClientFrame, clientId: ClientId): Promise<void> {
    const base = { protocolVersion: 1 as const, id: frame.id, documentId: frame.documentId }
    try {
      const key = this.key(clientId, frame.documentId)
      if (frame.type === 'harness:bind') {
        const existing = this.bindings.get(key)
        const sessionId = existing?.sessionId ?? await this.options.router.bindNativeSession({ hostId: this.options.hostId, cwd: this.options.cwd, clientId, documentId: frame.documentId })
        this.options.router.assertNativeSessionOwner(sessionId, clientId)
        this.bindings.set(key, existing ?? { clientId, documentId: frame.documentId, sessionId, pending: new Map(), prepared: new Map(), approvals: new Map() })
        this.options.send(clientId, { ...base, type: 'harness:bound', sessionId })
        return
      }
      const binding = this.bindings.get(key)
      if (!binding) throw new Error('Native document has not been bound.')
      const owner = this.options.router.assertNativeSessionOwner(binding.sessionId, clientId)
      if (owner.documentId !== frame.documentId) throw new Error('Native document ownership mismatch.')
      if (frame.type === 'harness:rpc' && frame.endpoint === '$events/result') {
        const args = (frame.payload as { args?: { clientId?: unknown; eventId?: unknown; outcome?: { kind?: unknown; value?: unknown } } } | null)?.args
        if (typeof args?.eventId === 'string' && args.eventId.startsWith('office-approval:')) {
          const approvalId = binding.approvals.get(args.eventId)
          if (!approvalId || !binding.eventStream || args.clientId !== binding.eventStream.token || !this.options.answerApproval) throw new Error('Native approval ownership changed.')
          let outcome: ApprovalOutcome
          if (args.outcome?.kind === 'result' && (args.outcome.value === 'allowed-once' || args.outcome.value === 'rejected' || args.outcome.value === 'cancelled' || args.outcome.value === 'unavailable')) outcome = args.outcome.value
          else if (args.outcome?.kind === 'next' || args.outcome?.kind === 'rejected') outcome = 'unavailable'
          else throw new Error('Invalid native approval answer.')
          binding.approvals.delete(args.eventId)
          await this.options.answerApproval(approvalId, outcome, clientId)
          this.options.send(clientId, { ...base, type: 'harness:result', result: { ok: true } })
          return
        }
      }
      let context
      if (frame.type === 'harness:prepare') {
        if (binding.prepared.size >= 128 || binding.prepared.has(frame.requestId)) throw new Error('Duplicate prepared submission.')
        const prepared = this.options.router.prepareNativeTurn({ sessionId: binding.sessionId, clientId, requestId: frame.requestId, selection: frame.selection })
        if (prepared.context.revision !== frame.revision) throw new Error('The submitted document revision is stale.')
        context = prepared.context
        binding.prepared.set(frame.requestId, { revision: frame.revision, selection: structuredClone(frame.selection) })
      }
      if (frame.type === 'harness:rpc' && frame.endpoint === 'session/prompt') {
        const requestId = (frame.payload as { args?: { request?: { requestId?: unknown } } } | null)?.args?.request?.requestId
        if (typeof requestId !== 'string') throw new Error('Missing native submission identity.')
        const prepared = binding.prepared.get(requestId)
        if (!prepared) throw new Error('No prepared native submission.')
        binding.prepared.delete(requestId)
        const current = this.options.router.prepareNativeTurn({ sessionId: binding.sessionId, clientId, requestId, selection: prepared.selection })
        if (current.context.revision !== prepared.revision) throw new Error('Document changed before native prompt admission.')
      }
      if (frame.type === 'harness:stream-cancel') {
        if (!binding.pending.has(frame.streamId as RequestId)) return
        binding.pending.delete(frame.streamId as RequestId)
        if (binding.eventStream?.id === frame.streamId) this.revokeApprovals(binding)
      } else {
        if (binding.pending.size >= 144 || binding.pending.has(frame.id)) throw new Error('Duplicate or excessive native requests.')
        binding.pending.set(frame.id, frame.type === 'harness:stream-open' ? frame.endpoint : false)
      }
      try {
        if (frame.type === 'harness:rpc' && frame.endpoint === 'session/cancel') {
          const sessionId = (frame.payload as { args?: { request?: { sessionId?: unknown } } } | null)?.args?.request?.sessionId
          if (sessionId !== binding.sessionId) throw new Error('Native cancellation ownership mismatch.')
          this.options.router.expireNativeSessionApprovals(binding.sessionId, clientId)
        }
        this.options.forward({ type: 'office:client', protocolVersion: 1, id: frame.id, clientId, sessionId: binding.sessionId, frame, ...(context ? { context } : {}) })
      } catch (error) { binding.pending.delete(frame.id); throw error }
    } catch {
      this.options.send(clientId, { ...base, type: 'harness:error', message: '无法确认当前文档会话或选区，请重新连接；已提交修改的结果需先核实。' })
    }
  }

  receive(frame: Extract<RuntimeResponseFrame, { type: 'office:client-result' }>): void {
    const binding = this.bindings.get(this.key(frame.clientId, frame.frame.documentId))
    if (!binding || !binding.pending.has(frame.frame.id)) return
    try {
      this.options.router.assertNativeSessionOwner(binding.sessionId, frame.clientId)
      if (frame.frame.type === 'harness:stream-item' && binding.pending.get(frame.frame.id) === '$events') {
        const value = frame.frame.value as { type?: unknown; clientId?: unknown } | null
        if (value?.type === 'ready' && typeof value.clientId === 'string') binding.eventStream = { id: frame.frame.id, token: value.clientId }
      }
      if (frame.frame.type !== 'harness:stream-item' && binding.eventStream?.id === frame.frame.id) this.revokeApprovals(binding)
      if (frame.frame.type !== 'harness:stream-item') binding.pending.delete(frame.frame.id)
      this.options.send(frame.clientId, frame.frame)
    } catch { this.disconnect(frame.clientId) }
  }

  presentApproval(clientId: ClientId, frame: ApprovalRequestFrame): boolean {
    const binding = [...this.bindings.values()].find((entry) => entry.clientId === clientId && entry.sessionId === frame.sessionId)
    if (!binding) return false
    if (!binding.eventStream || binding.approvals.size >= 128) {
      void Promise.resolve().then(() => this.options.answerApproval?.(frame.id, 'unavailable', clientId)).catch(() => undefined)
      return true
    }
    const eventId = `office-approval:${randomUUID()}`
    binding.approvals.set(eventId, frame.id)
    this.options.send(clientId, {
      protocolVersion: 1, type: 'harness:stream-item', id: binding.eventStream.id, documentId: binding.documentId,
      value: { type: 'waterfall', event: 'approval/request', eventId, agentId: binding.sessionId,
        request: { toolName: frame.toolName, reason: frame.proposal?.summary ?? frame.reason ?? '请确认是否执行本次文档修改。' } },
    })
    return true
  }

  cancelApproval(clientId: ClientId, approvalId: string): void {
    for (const binding of this.bindings.values()) {
      if (binding.clientId !== clientId) continue
      for (const [eventId, parentId] of binding.approvals) {
        if (parentId !== approvalId) continue
        binding.approvals.delete(eventId)
        if (binding.eventStream) {
          try { this.options.send(clientId, { protocolVersion: 1, type: 'harness:stream-item', id: binding.eventStream.id, documentId: binding.documentId, value: { type: 'cancel', eventId } }) }
          catch { /* Expiration is authoritative even if the browser has already disconnected. */ }
        }
      }
    }
  }

  private revokeApprovals(binding: Binding): void {
    delete binding.eventStream
    for (const approvalId of binding.approvals.values()) void Promise.resolve().then(() => this.options.answerApproval?.(approvalId, 'unavailable', binding.clientId)).catch(() => undefined)
    binding.approvals.clear()
  }

  disconnect(clientId: ClientId): void {
    for (const [key, binding] of this.bindings) if (binding.clientId === clientId) { this.revokeApprovals(binding); this.bindings.delete(key) }
    try { this.options.forward({ type: 'office:detach', protocolVersion: 1, id: randomUUID(), clientId }) } catch { /* exited runtime has already lost all streams */ }
  }

  runtimeExited(): void {
    for (const binding of this.bindings.values()) {
      for (const id of binding.pending.keys()) {
        try { this.options.send(binding.clientId, {
          protocolVersion: 1, type: 'harness:error', id, documentId: binding.documentId,
          message: '本地 AI 服务已中断，操作结果尚未核实；请重新连接后检查文件。',
        }) } catch { /* Offline clients must not interrupt cleanup of other bindings. */ }
      }
    }
    this.bindings.clear()
  }
}
