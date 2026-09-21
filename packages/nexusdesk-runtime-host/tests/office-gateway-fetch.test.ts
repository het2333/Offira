import { describe, expect, it } from 'vitest'
import { createOfficeGatewayFetch } from '../src/office-gateway-fetch'

describe('in-process official Connection dispatch', () => {
  it('accepts official void success with an omitted JSON value', async () => {
    const dispatch = createOfficeGatewayFetch({
      async fetch(request) {
        const message = await request.json()
        return Response.json({
          type: 'server-response',
          rpcId: message.rpcId,
          result: { ok: true },
        })
      },
    })
    expect(await dispatch('$events/result', { args: {} })).toEqual({ ok: true, value: undefined })
  })

  it('uses the official envelope and preserves remote failure results', async () => {
    const payload = { args: { clientId: 'private', eventId: 'event', outcome: { kind: 'next' } } }
    const failure = { ok: false, error: { code: 'expired', message: 'Expired', details: {} } }
    const dispatch = createOfficeGatewayFetch({
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe('/api/$events/result')
        expect(request.method).toBe('POST')
        const message = await request.json()
        expect(message).toMatchObject({ type: 'client-request', method: '$events/result', payload })
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result: failure })
      },
    })
    expect(await dispatch('$events/result', payload)).toEqual(failure)
  })

  it('rejects mismatched correlation and never retries', async () => {
    let calls = 0
    const dispatch = createOfficeGatewayFetch({
      async fetch() {
        calls++
        return Response.json({
          type: 'server-response',
          rpcId: 'wrong',
          result: { ok: true, value: {} },
        })
      },
    })
    await expect(dispatch('session/prompt', {})).rejects.toThrow('correlation')
    expect(calls).toBe(1)
  })

  it('rejects HTTP failures and path injection before dispatch', async () => {
    let calls = 0
    const dispatch = createOfficeGatewayFetch({
      async fetch() {
        calls++
        return new Response('', { status: 500 })
      },
    })
    await expect(dispatch('../credentials', {})).rejects.toThrow('endpoint')
    expect(calls).toBe(0)
    await expect(dispatch('session/page', {})).rejects.toThrow('500')
    expect(calls).toBe(1)
  })

  it('does not dispatch an aborted request or accept a malformed result', async () => {
    let calls = 0
    const dispatch = createOfficeGatewayFetch({
      async fetch(request) {
        calls++
        const message = await request.json()
        return Response.json({
          type: 'server-response',
          rpcId: message.rpcId,
          result: { ok: 'true' },
        })
      },
    })
    await expect(dispatch('session/prompt', {}, AbortSignal.abort())).rejects.toThrow()
    expect(calls).toBe(0)
    await expect(dispatch('session/page', {})).rejects.toThrow('Invalid Gateway result')
    expect(calls).toBe(1)
  })
})
