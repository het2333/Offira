import { describe, expect, it } from 'vitest'

import { projectDurableEvent, projectStreamChunk } from '../src/projection'

describe('projectStreamChunk', () => {
  it('never forwards model reasoning deltas', () => {
    expect(
      projectStreamChunk(
        'session-1',
        {
          type: 'reasoning-delta',
          index: 0,
          text: 'private reasoning',
        },
        new Set([0]),
      ),
    ).toBeUndefined()
  })

  it('forwards text only while a text block is open and drops raw fields', () => {
    const openText = new Set([2])
    expect(
      projectStreamChunk(
        'session-1',
        {
          type: 'text-delta',
          index: 2,
          text: 'hello',
          internalHandle: { unsafe: true },
        },
        openText,
      ),
    ).toEqual({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: {
        type: 'stream/chunk',
        data: { type: 'text-delta', index: 2, text: 'hello' },
      },
    })
    expect(
      projectStreamChunk(
        'session-1',
        {
          type: 'text-delta',
          index: 3,
          text: 'hidden',
        },
        openText,
      ),
    ).toBeUndefined()
  })

  it('forwards tool call deltas without arbitrary runtime objects', () => {
    expect(
      projectStreamChunk(
        'session-1',
        {
          type: 'tool-call-delta',
          index: 1,
          name: 'apply_sheet_operations',
          text: '{"ops":',
          runtime: new Map(),
        },
        new Set(),
      ),
    ).toMatchObject({
      event: {
        data: {
          type: 'tool-call-delta',
          index: 1,
          name: 'apply_sheet_operations',
          text: '{"ops":',
        },
      },
    })
  })
})

describe('projectDurableEvent', () => {
  it('projects the pinned Harness tool-call shape into product-owned fields', () => {
    expect(
      projectDurableEvent('session-1', {
        type: 'tool/call',
        seq: 7,
        data: { callId: 'call-1', name: 'read_sheet', arguments: { range: 'A1:B2' } },
      }),
    ).toEqual({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: {
        type: 'tool/call',
        seq: 7,
        data: { callId: 'call-1', name: 'read_sheet', arguments: { range: 'A1:B2' } },
      },
    })
  })

  it('drops reasoning-bearing and unknown durable events entirely', () => {
    expect(
      projectDurableEvent('session-1', {
        type: 'assistant/attempt',
        data: { reasoning: 'REASONING_SENTINEL', stream: [{ secret: true }] },
      }),
    ).toBeUndefined()
    expect(
      projectDurableEvent('session-1', {
        type: 'plugin/private-event',
        data: { secret: 'PRIVATE_SENTINEL' },
      }),
    ).toBeUndefined()
  })

  it('drops arbitrary tool metadata and bounds rendered result text', () => {
    expect(
      projectDurableEvent('session-1', {
        type: 'tool/result',
        seq: 8,
        data: {
          turn: 1,
          step: 2,
          message: {
            id: 'message-1',
            role: 'user',
            source: { kind: 'tool', callId: 'call-1' },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                isError: false,
                content: [{ type: 'text', text: 'x'.repeat(80_000) }],
              },
            ],
          },
          meta: { reasoning: 'REASONING_SENTINEL' },
        },
      }),
    ).toMatchObject({
      event: {
        seq: 8,
        data: {
          callId: 'call-1',
          isError: false,
          contentText: expect.stringMatching(/…$/),
        },
      },
    })
    expect(
      JSON.stringify(
        projectDurableEvent('session-1', {
          type: 'tool/result',
          data: {
            turn: 1,
            step: 2,
            message: {
              id: 'message-2',
              role: 'user',
              source: { kind: 'tool', callId: 'call-1' },
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'call-1',
                  content: [{ type: 'text', text: 'done' }],
                },
              ],
            },
            meta: { internal: 'PRIVATE' },
          },
        }),
      ),
    ).not.toContain('PRIVATE')
  })
})
