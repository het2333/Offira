import { describe, expect, it } from 'vitest'

import { projectDurableEvent, projectStreamChunk } from '../src/projection'

describe('projectStreamChunk', () => {
  it('never forwards model reasoning deltas', () => {
    expect(projectStreamChunk('session-1', {
      type: 'reasoning-delta',
      index: 0,
      text: 'private reasoning',
    }, new Set([0]))).toBeUndefined()
  })

  it('forwards text only while a text block is open and drops raw fields', () => {
    const openText = new Set([2])
    expect(projectStreamChunk('session-1', {
      type: 'text-delta',
      index: 2,
      text: 'hello',
      internalHandle: { unsafe: true },
    }, openText)).toEqual({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: {
        type: 'stream/chunk',
        data: { type: 'text-delta', index: 2, text: 'hello' },
      },
    })
    expect(projectStreamChunk('session-1', {
      type: 'text-delta',
      index: 3,
      text: 'hidden',
    }, openText)).toBeUndefined()
  })

  it('forwards tool call deltas without arbitrary runtime objects', () => {
    expect(projectStreamChunk('session-1', {
      type: 'tool-call-delta',
      index: 1,
      name: 'apply_sheet_operations',
      text: '{"ops":',
      runtime: new Map(),
    }, new Set())).toMatchObject({
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
  it('projects a durable tool event to JSON data', () => {
    expect(projectDurableEvent('session-1', {
      type: 'tool/call',
      seq: 7,
      data: { tool: 'read_sheet', arguments: { range: 'A1:B2' } },
    })).toEqual({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: {
        type: 'tool/call',
        seq: 7,
        data: { tool: 'read_sheet', arguments: { range: 'A1:B2' } },
      },
    })
  })

  it('drops non-JSON runtime values instead of exposing engine objects', () => {
    expect(projectDurableEvent('session-1', {
      type: 'tool/result',
      data: {
        text: 'done',
        runtime: new (class RuntimeHandle { stop() {} })(),
        callback: () => undefined,
      },
    })).toMatchObject({ event: { data: { text: 'done' } } })
  })
})
