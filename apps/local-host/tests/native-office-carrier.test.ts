import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRouter } from '../src/agent-router'
import { DocumentRegistry } from '../src/document-registry'
import type { HarnessSupervisor } from '../src/harness-supervisor'
import { NativeOfficeCarrier } from '../src/native-office-carrier'
import { OperationStore } from '../src/operation-store'

const nativeRouters: AgentRouter[] = []
afterEach(() => { for (const router of nativeRouters.splice(0)) router.dispose() })

function fixture() {
  const sent: any[] = []
  const forwarded: any[] = []
  const answerApproval = vi.fn()
  const send = vi.fn((_client: unknown, frame: unknown) => { sent.push(frame) })
  const router = {
    bindNativeSession: vi.fn(async () => 'session1' as never),
    assertNativeSessionOwner: vi.fn(() => ({ documentId: 'doc1', clientId: 'c1', hostId: 'host1' }) as never),
    prepareNativeTurn: vi.fn(() => ({ requestId: 'r1', sessionId: 'session1', context: { revision: 2 }, contextText: 'selection' }) as never),
    expireNativeSessionApprovals: vi.fn(),
  }
  const carrier = new NativeOfficeCarrier({ router, hostId: 'host1', cwd: '/trusted', answerApproval, send, forward: (frame) => forwarded.push(frame) })
  const frame = (value: object) => ({ protocolVersion: 1, id: 'id1', documentId: 'doc1', ...value }) as any
  return { carrier, router, sent, forwarded, frame, answerApproval, send }
}

async function pendingApproval() {
  const f = fixture()
  await f.carrier.handle(f.frame({ type: 'harness:bind' }), 'c1' as never)
  await f.carrier.handle(f.frame({ type: 'harness:stream-open', id: 'events', endpoint: '$events', payload: { args: {} } }), 'c1' as never)
  f.carrier.receive({ type: 'office:client-result', protocolVersion: 1, clientId: 'c1', frame: {
    type: 'harness:stream-item', protocolVersion: 1, id: 'events', documentId: 'doc1',
    value: { type: 'ready', clientId: 'event-token' },
  } } as any)
  f.carrier.presentApproval('c1' as never, { type: 'approval:request', protocolVersion: 1,
    id: 'approval1', sessionId: 'session1', toolName: 'apply_sheet_operations' } as any)
  const eventId = f.sent.at(-1).value.eventId
  const answer = (value: string, token = 'event-token') => f.frame({ type: 'harness:rpc', id: 'answer',
    endpoint: '$events/result', payload: { args: { clientId: token, eventId, outcome: { kind: 'result', value } } } })
  return { ...f, eventId, answer }
}

async function routedApproval() {
  const sent: any[] = []
  const forwarded: any[] = []
  const documents = new DocumentRegistry([{ documentId: 'doc1', editorType: 'sheets', revision: 2 }])
  documents.register({ documentId: 'doc1', clientId: 'c1', editorType: 'sheets', revision: 2 } as any)
  const supervisor = {
    onFrame: () => () => {}, onExit: () => () => {},
    bindOfficeSession: async () => ({ sessionId: 'session1', resumed: false }),
    respondApproval: vi.fn(), respondEditor: vi.fn(),
  }
  const router = new AgentRouter({
    supervisor: supervisor as unknown as HarnessSupervisor, documents, operations: new OperationStore(),
    sendToClient: (clientId, frame) => {
      if (frame.type === 'approval:request' && carrier.presentApproval(clientId, frame)) return
      sent.push(frame)
    },
    onApprovalExpired: (clientId, id) => carrier.cancelApproval(clientId, id),
  })
  nativeRouters.push(router)
  const carrier = new NativeOfficeCarrier({
    router, hostId: 'host1', cwd: '/trusted',
    send: (_clientId, frame) => { sent.push(frame) },
    forward: (frame) => { forwarded.push(frame) },
    answerApproval: (id, outcome, clientId) => router.handleClientFrame({ type: 'approval:response', protocolVersion: 1, id, outcome }, clientId),
  })
  const frame = (value: object) => ({ protocolVersion: 1, documentId: 'doc1', ...value }) as any
  await carrier.handle(frame({ type: 'harness:bind', id: 'bind' }), 'c1' as never)
  await carrier.handle(frame({ type: 'harness:stream-open', id: 'events', endpoint: '$events', payload: { args: {} } }), 'c1' as never)
  carrier.receive({ type: 'office:client-result', protocolVersion: 1, clientId: 'c1', frame: frame({ type: 'harness:stream-item', id: 'events', value: { type: 'ready', clientId: 'event-token' } }) } as any)
  router.routeRuntimeFrame({ type: 'approval:request', protocolVersion: 1, id: 'approval1', sessionId: 'session1', toolName: 'apply_sheet_operations',
    proposal: { operationId: 'op1', planHash: 'plan1', summary: 'Write Summary!C4', targets: ['Summary!C4'] } } as any)
  const eventId = sent.at(-1).value.eventId
  const answer = frame({ type: 'harness:rpc', id: 'answer', endpoint: '$events/result', payload: { args: { clientId: 'event-token', eventId, outcome: { kind: 'result', value: 'allowed-once' } } } })
  const cancel = frame({ type: 'harness:rpc', id: 'cancel', endpoint: 'session/cancel', payload: { args: { request: { sessionId: 'session1' } } } })
  const mutation = { type: 'editor:request', protocolVersion: 1, id: 'mutation',
    target: { sessionId: 'session1', clientId: 'c1', documentId: 'doc1', editorType: 'sheets', revision: 2, operationId: 'op1' },
    command: 'apply_ops', arguments: { ops: [] }, approval: { id: 'approval1', planHash: 'plan1' } } as any
  return { carrier, router, sent, forwarded, answer, cancel, mutation, eventId }
}

describe('authenticated Host native Office carrier', () => {
  it.each(['pending', 'granted'])('invalidates a %s approval before forwarding native Session cancellation', async (state) => {
    const f = await routedApproval()
    if (state === 'granted') await f.carrier.handle(f.answer, 'c1' as never)

    await f.carrier.handle(f.cancel, 'c1' as never)

    expect(f.router.hasApproval('approval1')).toBe(false)
    if (state === 'pending') {
      expect(f.sent.some((frame) => frame.type === 'harness:stream-item' && frame.value.type === 'cancel' && frame.value.eventId === f.eventId)).toBe(true)
      await f.carrier.handle(f.answer, 'c1' as never)
      expect(f.sent.at(-1).type).toBe('harness:error')
    }
    expect(() => f.router.routeRuntimeFrame(f.mutation)).toThrow(/matching one-time approval/i)
    expect(f.sent.some((frame) => frame.type === 'editor:request')).toBe(false)
    expect(f.forwarded.at(-1).frame).toEqual(f.cancel)
  })

  it('rejects a foreign Session cancel without invalidating the bound Session approval', async () => {
    const f = await routedApproval()
    const before = f.forwarded.length
    await f.carrier.handle({ ...f.cancel, payload: { args: { request: { sessionId: 'foreign-session' } } } }, 'c1' as never)
    expect(f.router.hasApproval('approval1')).toBe(true)
    expect(f.sent.at(-1).type).toBe('harness:error')
    expect(f.forwarded).toHaveLength(before)
  })

  it('expires the approval even when its browser can no longer receive cancellation', async () => {
    const f = await pendingApproval()
    f.send.mockImplementationOnce(() => { throw new Error('Socket is closing') })
    expect(() => f.carrier.cancelApproval('c1' as never, 'approval1')).not.toThrow()
    await f.carrier.handle(f.answer('allowed-once'), 'c1' as never)
    expect(f.answerApproval).not.toHaveBeenCalled()
    expect(f.sent.at(-1).type).toBe('harness:error')
  })

  it('clears bindings after runtime exit even when a browser socket is closing', async () => {
    const f = await pendingApproval()
    f.send.mockImplementationOnce(() => { throw new Error('Socket is closing') })
    expect(() => f.carrier.runtimeExited()).not.toThrow()
    expect(() => f.carrier.assertBound('c1' as never, 'doc1' as never)).toThrow()
  })

  it.each(['cancelled', 'unavailable'])('settles the official %s answer without leaving a live approval', async (outcome) => {
    const f = await pendingApproval()
    await f.carrier.handle(f.answer(outcome), 'c1' as never)
    expect(f.answerApproval).toHaveBeenCalledExactlyOnceWith('approval1', outcome, 'c1')
    await f.carrier.handle(f.answer('allowed-once'), 'c1' as never)
    expect(f.answerApproval).toHaveBeenCalledTimes(1)
  })

  it('rejects expired cards and forged event tokens without granting the parent operation', async () => {
    const f = await pendingApproval()
    await f.carrier.handle(f.answer('allowed-once', 'foreign-token'), 'c1' as never)
    expect(f.answerApproval).not.toHaveBeenCalled()
    f.carrier.cancelApproval('c1' as never, 'approval1')
    expect(f.sent.at(-1).value).toEqual({ type: 'cancel', eventId: f.eventId })
    await f.carrier.handle(f.answer('allowed-once'), 'c1' as never)
    expect(f.answerApproval).not.toHaveBeenCalled()
    expect(f.sent.at(-1).type).toBe('harness:error')
  })

  it('revokes a pending card when its event stream closes', async () => {
    const f = await pendingApproval()
    await f.carrier.handle(f.frame({ type: 'harness:stream-cancel', id: 'cancel', streamId: 'events' }), 'c1' as never)
    await Promise.resolve()
    expect(f.answerApproval).toHaveBeenCalledExactlyOnceWith('approval1', 'unavailable', 'c1')
    await f.carrier.handle(f.answer('allowed-once'), 'c1' as never)
    expect(f.answerApproval).toHaveBeenCalledTimes(1)
  })

  it('fails closed without throwing when an unavailable approval callback rejects synchronously', async () => {
    const f = fixture()
    await f.carrier.handle(f.frame({ type: 'harness:bind' }), 'c1' as never)
    f.answerApproval.mockImplementation(() => { throw new Error('Runtime disconnected') })
    expect(() => f.carrier.presentApproval('c1' as never, { type: 'approval:request', protocolVersion: 1,
      id: 'approval1', sessionId: 'session1', toolName: 'apply_sheet_operations' } as any)).not.toThrow()
    await Promise.resolve()
  })

  it('presents an exact parent approval in the native stream and consumes the answer once', async () => {
    const f = fixture()
    await f.carrier.handle(f.frame({ type: 'harness:bind' }), 'c1' as never)
    await f.carrier.handle(f.frame({ type: 'harness:stream-open', id: 'events', endpoint: '$events', payload: { args: {} } }), 'c1' as never)
    f.carrier.receive({ type: 'office:client-result', protocolVersion: 1, clientId: 'c1', frame: { type: 'harness:stream-item', protocolVersion: 1, id: 'events', documentId: 'doc1', value: { type: 'ready', clientId: 'event-token' } } } as any)
    expect(f.carrier.presentApproval('c1' as never, { type: 'approval:request', protocolVersion: 1, id: 'approval1', sessionId: 'session1', toolName: 'apply_sheet_operations', reason: '将合计写入 C4' } as any)).toBe(true)
    const event = f.sent.at(-1).value
    expect(event).toMatchObject({ type: 'waterfall', event: 'approval/request', agentId: 'session1', request: { reason: '将合计写入 C4' } })
    const answer = f.frame({ type: 'harness:rpc', id: 'answer1', endpoint: '$events/result', payload: { args: { clientId: 'event-token', eventId: event.eventId, outcome: { kind: 'result', value: 'allowed-once' } } } })
    await f.carrier.handle(answer, 'c1' as never)
    expect(f.answerApproval).toHaveBeenCalledExactlyOnceWith('approval1', 'allowed-once', 'c1')
    await f.carrier.handle({ ...answer, id: 'answer2' }, 'c1' as never)
    expect(f.answerApproval).toHaveBeenCalledTimes(1)
    expect(f.sent.at(-1).type).toBe('harness:error')
  })

  it('revalidates the Host revision at prompt admission after preparation', async () => {
    const f = fixture()
    await f.carrier.handle(f.frame({ type: 'harness:bind' }), 'c1' as never)
    await f.carrier.handle(f.frame({ type: 'harness:prepare', id: 'prepare', requestId: 'r1', revision: 2, selection: {} }), 'c1' as never)
    expect(f.forwarded).toHaveLength(1)
    f.router.prepareNativeTurn.mockReturnValueOnce({ requestId: 'r1', sessionId: 'session1', context: { revision: 3 }, contextText: 'changed' } as never)
    await f.carrier.handle(f.frame({ type: 'harness:rpc', id: 'prompt', endpoint: 'session/prompt', payload: { args: { request: { requestId: 'r1', sessionId: 'session1', mode: 'queue', content: [] } } } }), 'c1' as never)
    expect(f.forwarded).toHaveLength(1)
    expect(f.sent.at(-1).type).toBe('harness:error')
  })

  it('binds through the authorized router and forwards finite stream admission immediately', async () => {
    const f = fixture()
    await f.carrier.handle(f.frame({ type: 'harness:bind' }), 'c1' as never)
    expect(f.router.bindNativeSession).toHaveBeenCalledWith({ hostId: 'host1', cwd: '/trusted', clientId: 'c1', documentId: 'doc1' })
    expect(f.sent[0]).toMatchObject({ type: 'harness:bound', sessionId: 'session1' })
    await f.carrier.handle(f.frame({ type: 'harness:stream-open', id: 'stream1', endpoint: '$events', payload: { args: {} } }), 'c1' as never)
    expect(f.forwarded[0]).toMatchObject({ type: 'office:client', sessionId: 'session1', clientId: 'c1' })
    f.carrier.disconnect('c1' as never)
    expect(f.forwarded.at(-1).type).toBe('office:detach')
  })

  it('rejects unbound RPC and stale captured revision before runtime dispatch', async () => {
    const f = fixture()
    await f.carrier.handle(f.frame({ type: 'harness:rpc', endpoint: 'session/modelCatalog', payload: { args: {} } }), 'c1' as never)
    expect(f.forwarded).toHaveLength(0)
    expect(f.sent.at(-1).type).toBe('harness:error')
    await f.carrier.handle(f.frame({ type: 'harness:bind' }), 'c1' as never)
    await f.carrier.handle(f.frame({ type: 'harness:prepare', requestId: 'r1', revision: 1, selection: {} }), 'c1' as never)
    expect(f.forwarded).toHaveLength(0)
    expect(f.sent.at(-1).type).toBe('harness:error')
  })
})
