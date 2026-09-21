import { describe, expect, it } from 'vitest'
import {
  authorizeOfficeGatewayRequest,
  filterOfficeControlFrame,
  OfficeRemoteEventFilter,
} from '../src/office-gateway-policy'

const binding = { sessionId: 'office-a' }
const request = (value: unknown) => ({ args: { request: value } })

describe('Office native gateway authorization', () => {
  it('admits only the bound session and ordinary read addresses', () => {
    const payload = request({ address: { kind: 'session', sessionId: 'office-a' }, throughSeq: 8 })
    expect(authorizeOfficeGatewayRequest(binding, 'call', 'session/page', payload)).toEqual(payload)
    expect(() =>
      authorizeOfficeGatewayRequest(
        binding,
        'call',
        'session/page',
        request({ address: { kind: 'session', sessionId: 'office-b' }, throughSeq: 8 }),
      ),
    ).toThrow()
    expect(() =>
      authorizeOfficeGatewayRequest(
        binding,
        'stream',
        'session/follow',
        request({
          address: {
            kind: 'subagent',
            parentSessionId: 'office-a',
            childSessionId: 'other',
            mode: 'one-shot',
          },
        }),
      ),
    ).toThrow()
  })

  it('rejects unknown capabilities and mode confusion before dispatch', () => {
    for (const endpoint of [
      'session/create',
      'session/fork',
      'session/list',
      'session/openWorkspacePath',
      'settings/update',
      'credentials/read',
      'subagents/spawn',
      '$events/result',
    ]) {
      expect(() => authorizeOfficeGatewayRequest(binding, 'call', endpoint, { args: {} })).toThrow()
    }
    expect(() =>
      authorizeOfficeGatewayRequest(
        binding,
        'call',
        'session/follow',
        request({ address: { kind: 'session', sessionId: 'office-a' } }),
      ),
    ).toThrow()
    expect(() =>
      authorizeOfficeGatewayRequest(
        binding,
        'stream',
        'session/cancel',
        request({ sessionId: 'office-a' }),
      ),
    ).toThrow()
  })

  it('admits queued native prompts without accepting another session or steering', () => {
    const prompt = {
      requestId: 'send-1',
      sessionId: 'office-a',
      mode: 'queue',
      content: [{ type: 'text', text: '求和' }],
    }
    expect(
      authorizeOfficeGatewayRequest(binding, 'call', 'session/prompt', request(prompt)),
    ).toEqual(request(prompt))
    expect(() =>
      authorizeOfficeGatewayRequest(
        binding,
        'call',
        'session/prompt',
        request({ ...prompt, sessionId: 'office-b' }),
      ),
    ).toThrow()
    expect(() =>
      authorizeOfficeGatewayRequest(
        binding,
        'call',
        'session/prompt',
        request({ ...prompt, mode: 'steer' }),
      ),
    ).toThrow()
    expect(() =>
      authorizeOfficeGatewayRequest(binding, 'call', 'session/prompt', {
        args: { request: prompt, otherSession: 'office-b' },
      }),
    ).toThrow()
  })

  it('scopes control baselines and drops foreign incremental frames', () => {
    expect(
      filterOfficeControlFrame('office-a', {
        type: 'baseline',
        value: {
          jobs: { 'office-a': [], 'office-b': [{ label: 'secret' }] },
          projections: { 'office-b': { private: true } },
        },
      }),
    ).toEqual({ type: 'baseline', value: { jobs: { 'office-a': [] }, projections: {} } })
    expect(
      filterOfficeControlFrame('office-a', { type: 'jobs', sessionId: 'office-b', jobs: [] }),
    ).toBeUndefined()
    expect(
      filterOfficeControlFrame('office-a', { type: 'jobs', sessionId: 'office-a', jobs: [] }),
    ).toEqual({ type: 'jobs', sessionId: 'office-a', jobs: [] })
  })
})

describe('Office question answer ownership', () => {
  it('bounds pending deliveries and invalidates unanswered questions on close', () => {
    const filter = new OfficeRemoteEventFilter('office-a', 'browser-token')
    expect(() => filter.receive({ type: 'waterfall', eventId: 'early' })).toThrow()
    filter.receive({ type: 'ready', clientId: 'private-client' })
    expect(() => filter.receive({ type: 'ready', clientId: 'second-client' })).toThrow()
    for (let index = 0; index < 128; index++) {
      filter.receive({
        type: 'waterfall',
        agentId: 'office-a',
        event: 'user-questions/request',
        eventId: `q-${index}`,
        request: {},
      })
    }
    expect(() =>
      filter.receive({
        type: 'waterfall',
        agentId: 'office-a',
        event: 'user-questions/request',
        eventId: 'overflow',
        request: {},
      }),
    ).toThrow()
    filter.close()
    expect(() =>
      filter.consume({
        args: { clientId: 'browser-token', eventId: 'q-0', outcome: { kind: 'next' } },
      }),
    ).toThrow()
  })

  it('hides the Gateway client identity and delegates other document questions', () => {
    const filter = new OfficeRemoteEventFilter('office-a', 'browser-token')
    expect(
      filter.receive({ type: 'ready', clientId: 'private-client', host: { home: '/home/test' } }),
    ).toEqual({
      forward: { type: 'ready', clientId: 'browser-token', host: { home: '/home/test' } },
    })
    expect(
      filter.receive({
        type: 'waterfall',
        agentId: 'office-b',
        event: 'user-questions/request',
        eventId: 'foreign',
        request: { questions: [] },
      }),
    ).toEqual({
      delegate: {
        args: { clientId: 'private-client', eventId: 'foreign', outcome: { kind: 'next' } },
      },
    })
    expect(() =>
      filter.consume({
        args: {
          clientId: 'browser-token',
          eventId: 'foreign',
          outcome: { kind: 'result', value: {} },
        },
      }),
    ).toThrow()
  })

  it('accepts one answer only for a delivered current question', () => {
    const filter = new OfficeRemoteEventFilter('office-a', 'browser-token')
    filter.receive({ type: 'ready', clientId: 'private-client', host: { home: '' } })
    const frame = {
      type: 'waterfall',
      agentId: 'office-a',
      event: 'user-questions/request',
      eventId: 'question-1',
      request: { questions: [] },
    }
    expect(filter.receive(frame)).toEqual({ forward: frame })
    const answer = {
      args: {
        clientId: 'browser-token',
        eventId: 'question-1',
        outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['只计算'] }] } },
      },
    }
    expect(() => filter.consume({ args: { ...answer.args, clientId: 'another-client' } })).toThrow()
    expect(filter.consume(answer)).toEqual({ args: { ...answer.args, clientId: 'private-client' } })
    expect(() => filter.consume(answer)).toThrow()
  })

  it('revokes cancelled and disconnected questions and suppresses sensitive notifications', () => {
    const filter = new OfficeRemoteEventFilter('office-a', 'browser-token')
    filter.receive({ type: 'ready', clientId: 'private-client', host: { home: '' } })
    filter.receive({
      type: 'waterfall',
      agentId: 'office-a',
      event: 'approval/request',
      eventId: 'a1',
      request: {},
    })
    expect(() =>
      filter.consume({
        args: {
          clientId: 'browser-token',
          eventId: 'a1',
          outcome: { kind: 'result', value: ['allowed-once'] },
        },
      }),
    ).toThrow()
    expect(filter.receive({ type: 'cancel', eventId: 'a1' })).toEqual({
      forward: { type: 'cancel', eventId: 'a1' },
    })
    expect(() =>
      filter.consume({
        args: {
          clientId: 'browser-token',
          eventId: 'a1',
          outcome: { kind: 'result', value: 'allowed-once' },
        },
      }),
    ).toThrow()
    expect(
      filter.receive({
        type: 'emit',
        event: 'credentials/reference-updated',
        args: [{ secret: 'hidden' }],
      }),
    ).toEqual({})
    expect(
      filter.receive({ type: 'emit', event: 'api-session/status', args: ['office-b', true] }),
    ).toEqual({})
    expect(
      filter.receive({ type: 'emit', event: 'api-session/status', args: ['office-a', true] }),
    ).toEqual({ forward: { type: 'emit', event: 'api-session/status', args: ['office-a', true] } })
    filter.close()
    expect(() => filter.receive({ type: 'ready', clientId: 'new', host: { home: '' } })).toThrow()
  })
})
