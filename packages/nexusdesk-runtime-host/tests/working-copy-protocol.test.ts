import { expect, it } from 'vitest'
import * as protocol from '../src/protocol'
it('validates persistence operation identity before returning a runtime editor result', () => {
  expect(typeof protocol.validateRuntimeEditorResponse).toBe('function')
  const frame = { type: 'editor:result', protocolVersion: 1, id: 'request',
    target: { documentId: 'doc', sessionId: 'session', clientId: 'client', editorType: 'docs', revision: 1, operationId: 'op' },
    currentRevision: 5, result: { ok: true, summary: 'Applied', warnings: [] },
    persistence: { documentEpoch: 'epoch', operationId: 'op', requestFingerprint: 'a'.repeat(64), blobHash: 'b'.repeat(64),
      checkpointId: 'checkpoint', workingRevision: 2, savedRevision: 1, dirty: true } } as unknown as protocol.RuntimeEditorResponseFrame
  expect(protocol.validateRuntimeEditorResponse(frame)).toEqual(frame)
  expect(() => protocol.validateRuntimeEditorResponse({ ...frame, persistence: { ...frame.persistence!, operationId: 'other' } })).toThrow(/operation/i)
  expect(() => protocol.validateRuntimeEditorResponse({ ...frame, currentRevision: 1 as never })).toThrow(/revision/i)
})
