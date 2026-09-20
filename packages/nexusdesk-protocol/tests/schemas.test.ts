import { describe, expect, it } from 'vitest'

import { parseAgentToolResult, parseClientFrame, PROTOCOL_VERSION } from '../src/index'

const mutationTarget = {
  sessionId: 'session-1',
  documentId: 'document-1',
  editorType: 'sheets',
  revision: 4,
  operationId: 'operation-1',
  clientId: 'client-1',
}

describe('parseClientFrame', () => {
  it('accepts durable registration, exact lookup and bounded persistence receipts', () => {
    const registration = { type: 'editor:register', protocolVersion: 1, id: 'register',
      clientId: 'client-1', rendererInstanceId: 'renderer-1', documentId: 'document-1',
      editorType: 'docs', revision: 2, documentEpoch: 'epoch-1', sourceContentId: 'a'.repeat(64),
      restoredCheckpointId: 'checkpoint-1' }
    expect(parseClientFrame(registration)).toEqual(registration)
    const lookup = { type: 'operation:lookup', protocolVersion: 1, id: 'lookup', operationId: 'op',
      documentId: 'document-1', documentEpoch: 'epoch-1', requestFingerprint: 'b'.repeat(64) }
    expect(parseClientFrame(lookup)).toEqual(lookup)
    expect(() => parseClientFrame({ ...lookup, documentEpoch: undefined })).toThrow()
    expect(() => parseClientFrame({ ...registration, sourceContentId: undefined })).toThrow()
    const result = { type: 'editor:result', protocolVersion: 1, id: 'result', target: mutationTarget,
      result: { ok: true, summary: 'applied', warnings: [] }, persistence: {
        documentEpoch: 'epoch-1', operationId: 'operation-1', requestFingerprint: 'b'.repeat(64),
        checkpointId: 'checkpoint-1', blobHash: 'a'.repeat(64), workingRevision: 2, savedRevision: 1, dirty: true } }
    expect(parseClientFrame(result)).toEqual(result)
    expect(() => parseClientFrame({ ...result, persistence: { ...result.persistence, path: '/tmp/private' } })).toThrow()
  })

  it('requires a non-empty renderer instance on editor registration', () => {
    const frame = {
      type: 'editor:register' as const,
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-1',
      clientId: 'client-1',
      rendererInstanceId: 'renderer-1',
      documentId: 'document-1',
      editorType: 'sheets',
      revision: 1,
    }

    expect(parseClientFrame(frame)).toEqual(frame)
    const { rendererInstanceId: _missing, ...withoutRenderer } = frame
    expect(() => parseClientFrame(withoutRenderer)).toThrow(/rendererInstanceId/)
    expect(() => parseClientFrame({ ...frame, rendererInstanceId: '' }))
      .toThrow(/rendererInstanceId/)
  })

  it('round-trips bounded read_sheet data in an editor result', () => {
    const frame = {
      type: 'editor:result' as const,
      protocolVersion: PROTOCOL_VERSION,
      id: 'request-read-1',
      target: mutationTarget,
      result: {
        ok: true,
        summary: 'Read Summary!A1:B2.',
        warnings: [],
        data: {
          sheet: 'Summary',
          cells: [
            { address: 'A1', value: 'Revenue' },
            { address: 'B2', value: 42 },
          ],
        },
      },
    }

    expect(parseClientFrame(frame)).toEqual(frame)
  })

  it('rejects a protocol version from a different contract', () => {
    expect(() =>
      parseClientFrame({
        type: 'editor:result',
        protocolVersion: PROTOCOL_VERSION + 1,
        id: 'request-1',
        target: mutationTarget,
        result: { ok: true, summary: 'done', warnings: [] },
      }),
    ).toThrow(/protocolVersion/)
  })

  it('rejects a mutation result without its operation identity', () => {
    const { operationId: _omitted, ...incompleteTarget } = mutationTarget
    expect(() =>
      parseClientFrame({
        type: 'editor:result',
        protocolVersion: PROTOCOL_VERSION,
        id: 'request-1',
        target: incompleteTarget,
        result: { ok: true, summary: 'done', warnings: [] },
      }),
    ).toThrow(/operationId/)
  })

  it('rejects a negative document revision', () => {
    expect(() =>
      parseClientFrame({
        type: 'editor:result',
        protocolVersion: PROTOCOL_VERSION,
        id: 'request-1',
        target: { ...mutationTarget, revision: -1 },
        result: { ok: true, summary: 'done', warnings: [] },
      }),
    ).toThrow(/revision/)
  })

  it('rejects an unknown frame type', () => {
    expect(() =>
      parseClientFrame({
        type: 'engine:escape-hatch',
        protocolVersion: PROTOCOL_VERSION,
      }),
    ).toThrow(/Invalid discriminator value/)
  })
})

describe('parseAgentToolResult', () => {
  it('rejects engine-owned fields that are not in the agent result contract', () => {
    expect(() =>
      parseAgentToolResult({
        ok: true,
        summary: 'updated one range',
        warnings: [],
        workbook: { getActiveSheet: () => undefined },
      }),
    ).toThrow(/Unrecognized key/)
  })

  it('accepts a bounded agent-oriented result', () => {
    expect(
      parseAgentToolResult({
        ok: true,
        summary: 'updated one range',
        changes: { targets: ['Summary!B2'], count: 1 },
        warnings: [],
        verification: { passed: true, issues: [] },
        transactionId: 'transaction-1',
      }),
    ).toEqual({
      ok: true,
      summary: 'updated one range',
      changes: { targets: ['Summary!B2'], count: 1 },
      warnings: [],
      verification: { passed: true, issues: [] },
      transactionId: 'transaction-1',
    })
  })
})
