import { describe, expect, it } from 'vitest'
import { parseClientFrame } from '../src/schemas'

describe('native Harness carrier frames', () => {
  it('accepts a document-bound RPC without trusting a browser client or cwd', () => {
    const frame = {
      type: 'harness:rpc',
      protocolVersion: 1,
      id: 'rpc-1',
      documentId: 'doc-1',
      endpoint: 'session/modelCatalog',
      payload: { args: {} },
    }
    expect(parseClientFrame(frame)).toEqual(frame)
    for (const extra of [
      { cwd: '/tmp' },
      { clientId: 'forged' },
      { sessionId: 'forged' },
      { channel: '/other' },
    ]) {
      expect(() => parseClientFrame({ ...frame, ...extra })).toThrow()
    }
  })

  it('rejects path injection and oversized envelopes', () => {
    const frame = {
      type: 'harness:stream-open',
      protocolVersion: 1,
      id: 'stream-1',
      documentId: 'doc-1',
      endpoint: '$events',
      payload: { args: {} },
    }
    expect(parseClientFrame(frame)).toEqual(frame)
    expect(() => parseClientFrame({ ...frame, endpoint: '../secrets' })).toThrow()
    expect(() =>
      parseClientFrame({ ...frame, payload: { text: 'x'.repeat(1024 * 1024) } }),
    ).toThrow()
  })

  it('requires a request-correlated context and bounded revision', () => {
    const frame = {
      type: 'harness:prepare',
      protocolVersion: 1,
      id: 'prepare-1',
      documentId: 'doc-1',
      requestId: 'native-1',
      revision: 2,
      selection: { kind: 'sheets', sheetId: 'sheet-1', a1: 'C1:C3' },
    }
    expect(parseClientFrame(frame)).toEqual(frame)
    expect(() => parseClientFrame({ ...frame, requestId: '' })).toThrow()
    expect(() => parseClientFrame({ ...frame, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
  })
})
