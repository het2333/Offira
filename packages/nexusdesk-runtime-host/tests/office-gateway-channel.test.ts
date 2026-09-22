import { describe, expect, it, vi } from 'vitest'
import { OfficeGatewayChannel } from '../src/office-gateway-channel'

function fixture(frames: unknown[] = []) {
  const dispatch = vi.fn(async () => ({ ok: true as const, value: {} }))
  const assertOwner = vi.fn()
  const preparePrompt = vi.fn(async (payload: Record<string, unknown>) => payload)
  const signals: AbortSignal[] = []
  const channel = new OfficeGatewayChannel({
    sessionId: 's1',
    assertOwner,
    dispatch,
    preparePrompt,
    open: (_endpoint, _payload, signal) => {
      signals.push(signal)
      return (async function* () {
        for (const frame of frames) yield frame
      })()
    },
  })
  return { channel, dispatch, assertOwner, preparePrompt, signals }
}

describe('document-bound native Gateway channel', () => {
  it('discovers only the bound session from the real catalog shape', async () => {
    const { channel, dispatch } = fixture()
    dispatch.mockResolvedValueOnce({ ok: true, value: { items: [{ sessionId: 's1' }, { sessionId: 'secret' }] } })
    expect(await channel.call('session/list', { args: { _request: {} } })).toEqual({ ok: true, value: { items: [{ sessionId: 's1' }] } })
  })
  it('projects real workspace baselines to only the bound session', async () => {
    const { channel } = fixture([{ type: 'baseline', value: {
      items: [{ workspaceId: 'w1', path: '/allowed', title: 'A', sessionIds: ['s1', 's2'] },
        { workspaceId: 'w2', path: '/private', sessionIds: ['s2'] }], archivedSessionIds: ['s1', 's2'],
    } }])
    const stream = channel.open('workspaces', 'workspace/follow', { args: {} })
    expect((await stream.next()).value).toEqual({ type: 'baseline', value: {
      items: [{ workspaceId: 'w1', path: '/allowed', title: 'A', sessionIds: ['s1'] }], archivedSessionIds: ['s1'],
    } })
    await stream.return(undefined)
  })

  it('reads official redacted settings but exposes no write controls', async () => {
    const { channel, dispatch } = fixture()
    dispatch.mockResolvedValueOnce({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })
    expect(await channel.call('settings/describe', { args: {} })).toEqual({ ok: true, value: { writable: false, hasDocument: false, namespaces: [] } })
  })
  it('rejects a preparation hook that changes the native request identity', async () => {
    const { channel, preparePrompt, dispatch } = fixture()
    preparePrompt.mockResolvedValueOnce({ args: { request: { sessionId: 's1', requestId: 'replacement', mode: 'queue', content: [] } } })
    await expect(channel.call('session/prompt', { args: { request: { sessionId: 's1', requestId: 'original', mode: 'queue', content: [] } } })).rejects.toThrow()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('permits only one event answerer stream per document channel', async () => {
    const { channel } = fixture([{ type: 'ready', clientId: 'private' }])
    const first = channel.open('e1', '$events', { args: {} })[Symbol.asyncIterator]()
    await first.next()
    const second = channel.open('e2', '$events', { args: {} })[Symbol.asyncIterator]()
    await expect(second.next()).rejects.toThrow()
    await first.return(undefined)
    channel.close()
  })

  it('checks ownership and frozen context before native prompt dispatch', async () => {
    const { channel, dispatch, preparePrompt, assertOwner } = fixture()
    const payload = {
      args: { request: { sessionId: 's1', requestId: 'r1', mode: 'queue', content: [] } },
    }
    await channel.call('session/prompt', payload)
    expect(assertOwner).toHaveBeenCalled()
    expect(preparePrompt).toHaveBeenCalledWith(payload)
    expect(dispatch).toHaveBeenCalledWith('session/prompt', payload, expect.any(AbortSignal))
    preparePrompt.mockRejectedValueOnce(new Error('Missing frozen context'))
    await expect(channel.call('session/prompt', payload)).rejects.toThrow('Missing frozen context')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('delegates foreign questions and sends owned answers to the official dispatcher once', async () => {
    const { channel, dispatch } = fixture([
      { type: 'ready', clientId: 'private' },
      { type: 'waterfall', agentId: 's2', event: 'user-questions/request', eventId: 'foreign' },
      { type: 'waterfall', agentId: 's1', event: 'user-questions/request', eventId: 'own' },
    ])
    const iterator = channel.open('events-1', '$events', { args: {} })[Symbol.asyncIterator]()
    const ready = (await iterator.next()).value as { clientId: string }
    expect(ready.clientId).not.toBe('private')
    expect((await iterator.next()).value).toMatchObject({ eventId: 'own' })
    expect(dispatch).toHaveBeenCalledWith(
      '$events/result',
      { args: { clientId: 'private', eventId: 'foreign', outcome: { kind: 'next' } } },
      expect.any(AbortSignal),
    )
    const answer = { args: { clientId: ready.clientId, eventId: 'own', outcome: { kind: 'next' } } }
    await channel.call('$events/result', answer)
    await expect(channel.call('$events/result', answer)).rejects.toThrow()
    await iterator.return?.(undefined)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('filters control and rejects unbound capabilities', async () => {
    const { channel, dispatch } = fixture([
      { type: 'jobs', sessionId: 's2', jobs: ['secret'] },
      { type: 'jobs', sessionId: 's1', jobs: [] },
    ])
    const frames = []
    for await (const frame of channel.open('control', 'session/control', { args: {} }))
      frames.push(frame)
    expect(frames).toEqual([{ type: 'jobs', sessionId: 's1', jobs: [] }])
    await expect(channel.call('session/list', { args: {} })).rejects.toThrow()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('aborts active streams on disconnect and rejects late answers', async () => {
    const { channel, signals } = fixture([{ type: 'ready', clientId: 'private' }])
    const iterator = channel.open('events', '$events', { args: {} })[Symbol.asyncIterator]()
    await iterator.next()
    channel.close()
    expect(signals[0]?.aborted).toBe(true)
    await expect(channel.call('session/modelCatalog', { args: {} })).rejects.toThrow()
    await iterator.return?.(undefined)
  })
})
