import { describe, expect, it, vi } from 'vitest'
import type {
  AgentServerFrame,
  ClientFrame,
  ClientId,
  DocumentId,
  Revision,
} from '@nexusdesk/protocol'
import type { NexusClient, NexusClientState } from '../src/client'
import { createHarnessTransport } from '../src/harness-transport'

function fixture() {
  const sent: ClientFrame[] = []
  const frames = new Set<(frame: AgentServerFrame) => void>()
  const states = new Set<(state: NexusClientState) => void>()
  const client: NexusClient = {
    state: 'ready',
    clientId: 'c1' as ClientId,
    connect() {},
    close() {},
    send(frame) {
      sent.push(frame)
    },
    request() {
      throw new Error('not used')
    },
    onFrame(listener) {
      frames.add(listener)
      return () => frames.delete(listener)
    },
    onState(listener) {
      states.add(listener)
      return () => states.delete(listener)
    },
  }
  return {
    sent,
    frames,
    states,
    transport: createHarnessTransport(client, 'doc1' as DocumentId),
    emit(frame: AgentServerFrame) {
      for (const listener of frames) listener(frame)
    },
  }
}

describe('Harness browser transport on the existing authenticated socket', () => {
  it('keeps a disconnected read subscription recoverable beyond 30 seconds and releases it on close', async () => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      const bound = f.transport.bind()
      f.emit({ protocolVersion: 1, type: 'harness:bound', id: f.sent[0]!.id, documentId: 'doc1' as DocumentId, sessionId: 'session1' as any })
      await bound
      for (const listener of f.states) listener('reconnecting')
      const iterator = f.transport.rpc.open('/api', 'session/follow', { args: {} }, new AbortController().signal)
      let settled = false
      const pending = iterator.next().then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(settled).toBe(false)
      expect(f.sent).toHaveLength(1)
      f.transport.dispose()
      await pending
      expect(settled).toBe(true)
    } finally { f.transport.dispose(); vi.useRealTimers() }
  })
  it('recovers an interrupted read-only history page after rebinding', async () => {
    const f = fixture()
    const bound = f.transport.bind()
    f.emit({ protocolVersion: 1, type: 'harness:bound', id: f.sent[0]!.id, documentId: 'doc1' as DocumentId, sessionId: 'session1' as any })
    await bound
    const page = f.transport.rpc.call('/api', 'session/page', { args: {} }).then(value => value, error => ({ error: error.message }))
    for (const listener of f.states) listener('reconnecting')
    const rebound = f.transport.bind()
    f.emit({ protocolVersion: 1, type: 'harness:bound', id: f.sent.at(-1)!.id, documentId: 'doc1' as DocumentId, sessionId: 'session1' as any })
    await rebound
    await vi.waitFor(() => expect(f.sent.filter(frame => frame.type === 'harness:rpc' && frame.endpoint === 'session/page')).toHaveLength(2))
    f.emit({ protocolVersion: 1, type: 'harness:result', id: f.sent.at(-1)!.id, documentId: 'doc1' as DocumentId, result: { ok: true, value: { messages: [] } } })
    expect(await page).toEqual({ ok: true, value: { messages: [] } })
    f.transport.dispose()
  })
  it('marks a lost read stream as a carrier failure so the official gateway recovers its cursor', async () => {
    const f = fixture()
    const iterator = f.transport.rpc.open('/api', 'session/follow', { args: {} }, new AbortController().signal)
    const first = iterator.next()
    f.emit({ protocolVersion: 1, type: 'harness:stream-item', id: f.sent[0]!.id, documentId: 'doc1' as DocumentId, value: { type: 'opened', cursor: 0 } })
    await first
    const next = iterator.next()
    const outcome = next.then(value => value, error => error.dshRemoteStreamFailure)
    for (const listener of f.states) listener('reconnecting')
    expect(await outcome).toEqual({ kind: 'carrier' })
    f.transport.dispose()
  })
  it.each(['editor:registered', 'editor:attached'])('rebinds after %s before reopening reads, without replaying a prompt', async (receiptType) => {
    const f = fixture()
    const bound = f.transport.bind()
    f.emit({ protocolVersion: 1, type: 'harness:bound', id: f.sent[0]!.id, documentId: 'doc1' as DocumentId, sessionId: 'session1' as any })
    await bound
    for (const listener of f.states) listener('reconnecting')
    for (const listener of f.states) listener('ready')
    const iterator = f.transport.rpc.open('/api', '$events', { args: {} }, new AbortController().signal)
    const next = iterator.next()
    expect(f.sent).toHaveLength(1)
    f.emit({ protocolVersion: 1, type: receiptType, documentId: 'other' as DocumentId } as any)
    expect(f.sent).toHaveLength(1)
    f.emit({ protocolVersion: 1, type: receiptType, documentId: 'doc1' as DocumentId } as any)
    await vi.waitFor(() => expect(f.sent).toHaveLength(2))
    expect(f.sent.at(-1)).toMatchObject({ type: 'harness:bind' })
    expect(f.sent).toHaveLength(2)
    f.emit({ protocolVersion: 1, type: 'harness:bound', id: f.sent[1]!.id, documentId: 'doc1' as DocumentId, sessionId: 'session1' as any })
    await vi.waitFor(() => expect(f.sent.at(-1)).toMatchObject({ type: 'harness:stream-open' }))
    f.emit({ protocolVersion: 1, type: 'harness:stream-item', id: f.sent.at(-1)!.id, documentId: 'doc1' as DocumentId, value: { type: 'ready' } })
    expect((await next).value).toEqual({ type: 'ready' })
    expect(f.sent.some(frame => frame.type === 'harness:rpc' && frame.endpoint === 'session/prompt')).toBe(false)
    await iterator.return(undefined)
    f.transport.dispose()
  })
  it('ends an unanswered admission without retrying or claiming it was not applied', async () => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      const call = f.transport.rpc.call('/api', 'session/modelCatalog', { args: {} })
      const result = expect(call).rejects.toThrow('尚未核实')
      await vi.advanceTimersByTimeAsync(30_000)
      await result
      expect(f.sent).toHaveLength(1)
    } finally {
      f.transport.dispose()
      vi.useRealTimers()
    }
  })

  it('freezes selection by native requestId and waits for Host preparation before prompting', async () => {
    const f = fixture()
    const selection = { kind: 'sheets', sheetId: 's1', a1: 'C1:C3' }
    f.transport.captureSubmission('native-1', { revision: 3 as Revision, selection })
    selection.a1 = 'A1:A9'
    const payload = {
      args: { request: { requestId: 'native-1', sessionId: 'session1', mode: 'queue' } },
    }
    const call = f.transport.rpc.call('/api', 'session/prompt', payload)
    expect(() => f.transport.captureSubmission('native-1', { revision: 3 as Revision, selection })).toThrow()
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]).toMatchObject({
      type: 'harness:prepare',
      requestId: 'native-1',
      selection: { a1: 'C1:C3' },
    })
    f.emit({
      type: 'harness:prepared',
      protocolVersion: 1,
      id: f.sent[0]!.id,
      documentId: 'doc1' as DocumentId,
      requestId: 'native-1',
    })
    await vi.waitFor(() => expect(f.sent).toHaveLength(2))
    expect(f.sent[1]).toMatchObject({ type: 'harness:rpc', endpoint: 'session/prompt', payload })
    f.emit({
      type: 'harness:result',
      protocolVersion: 1,
      id: f.sent[1]!.id,
      documentId: 'doc1' as DocumentId,
      result: { ok: true, value: {} },
    })
    await call
    await expect(f.transport.rpc.call('/api', 'session/prompt', payload)).rejects.toThrow()
    expect(f.sent).toHaveLength(2)
    f.transport.dispose()
  })

  it('rejects a stream queue overflow and releases its Host subscription', async () => {
    const f = fixture()
    const iterator = f.transport.rpc
      .open('/api', '$events', { args: {} }, new AbortController().signal)
      [Symbol.asyncIterator]()
    const first = iterator.next()
    const stream = f.sent[0]!
    f.emit({
      type: 'harness:stream-item',
      protocolVersion: 1,
      id: stream.id,
      documentId: 'doc1' as DocumentId,
      value: 'first',
    })
    await first
    for (let i = 0; i < 257; i++)
      f.emit({
        type: 'harness:stream-item',
        protocolVersion: 1,
        id: stream.id,
        documentId: 'doc1' as DocumentId,
        value: i,
      })
    await expect(iterator.next()).rejects.toThrow('缓冲上限')
    expect(f.sent.at(-1)).toMatchObject({ type: 'harness:stream-cancel', streamId: stream.id })
    f.transport.dispose()
  })

  it('correlates native calls and ignores another document response', async () => {
    const f = fixture()
    const result = f.transport.rpc.call('/api', 'session/modelCatalog', { args: {} })
    const id = f.sent[0]!.id
    f.emit({
      type: 'harness:result',
      protocolVersion: 1,
      id,
      documentId: 'other' as DocumentId,
      result: { ok: true, value: 'foreign' },
    })
    f.emit({
      type: 'harness:result',
      protocolVersion: 1,
      id,
      documentId: 'doc1' as DocumentId,
      result: { ok: true, value: [] },
    })
    expect(await result).toEqual({ ok: true, value: [] })
    f.transport.dispose()
    expect(f.frames.size).toBe(0)
  })

  it('streams without blocking a subsequent unary call and cancels on iterator return', async () => {
    const f = fixture()
    const iterator = f.transport.rpc
      .open('/api', '$events', { args: {} }, new AbortController().signal)
      [Symbol.asyncIterator]()
    const first = iterator.next()
    const stream = f.sent[0]!
    f.emit({
      type: 'harness:stream-item',
      protocolVersion: 1,
      id: stream.id,
      documentId: 'doc1' as DocumentId,
      value: { type: 'ready' },
    })
    expect((await first).value).toEqual({ type: 'ready' })
    const call = f.transport.rpc.call('/api', 'session/modelCatalog', { args: {} })
    const id = f.sent[1]!.id
    f.emit({
      type: 'harness:result',
      protocolVersion: 1,
      id,
      documentId: 'doc1' as DocumentId,
      result: { ok: true, value: [] },
    })
    await call
    await iterator.return?.(undefined)
    expect(f.sent.at(-1)).toMatchObject({ type: 'harness:stream-cancel', streamId: stream.id })
    f.transport.dispose()
  })

  it('rejects disconnected waits without replaying them when the socket returns', async () => {
    const f = fixture()
    const call = f.transport.rpc.call('/api', 'session/modelCatalog', { args: {} })
    const failure = expect(call).rejects.toThrow('连接')
    for (const listener of f.states) listener('reconnecting')
    await failure
    for (const listener of f.states) listener('ready')
    expect(f.sent).toHaveLength(1)
    f.transport.dispose()
  })

  it('rejects unknown channels and prompts with no captured submission', async () => {
    const f = fixture()
    await expect(
      f.transport.rpc.call('/other', 'session/modelCatalog', { args: {} }),
    ).rejects.toThrow()
    await expect(
      f.transport.rpc.call('/api', 'session/prompt', { args: { request: { requestId: 'r1' } } }),
    ).rejects.toThrow()
    expect(f.sent).toEqual([])
    f.transport.dispose()
  })
})
