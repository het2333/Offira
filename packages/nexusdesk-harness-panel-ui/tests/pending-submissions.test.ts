import { describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  OfficePanelCaptureFailure,
  startPendingSubmissionCapture,
} from '../src/pending-submissions.ts'

function snapshot(sessionId: string, requestIds: readonly string[]): SessionSnapshot {
  return {
    sessionId: sessionId as SessionId,
    pendingSubmissions: requestIds.map((requestId) => ({
      requestId: requestId as never,
      placement: 'transcript',
      time: 1,
      text: requestId,
      attachments: [],
    })),
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: requestIds.length > 0,
    awaitingFirstTurn: false,
  }
}

function sessionHarness(sessionId = 'session-1') {
  let value = snapshot(sessionId, [])
  const listeners = new Set<() => void>()
  return {
    session: {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    publish: (requestIds: readonly string[]) => {
      value = snapshot(sessionId, requestIds)
      queueMicrotask(() => {
        for (const listener of listeners) listener()
      })
    },
    listenerCount: () => listeners.size,
  }
}

describe('pending submission capture', () => {
  it('captures every native request id once before the next paint boundary', async () => {
    const harness = sessionHarness()
    const captureSubmission = vi.fn()
    const capture = startPendingSubmissionCapture({
      expectedSessionId: 'session-1',
      session: harness.session,
      captureSubmission,
    })

    harness.publish(['request-a', 'request-b'])
    await Promise.resolve()
    expect(captureSubmission.mock.calls).toEqual([['request-a'], ['request-b']])

    harness.publish(['request-a', 'request-b', 'request-c'])
    await Promise.resolve()
    expect(captureSubmission.mock.calls).toEqual([['request-a'], ['request-b'], ['request-c']])

    capture.dispose()
    expect(harness.listenerCount()).toBe(0)
  })

  it('rejects a Session snapshot that does not match the carrier binding', () => {
    const harness = sessionHarness('other-session')
    expect(() =>
      startPendingSubmissionCapture({
        expectedSessionId: 'session-1',
        session: harness.session,
        captureSubmission: vi.fn(),
      }),
    ).toThrow(/expected.*session-1.*other-session/i)
    expect(harness.listenerCount()).toBe(0)
  })

  it('publishes capture failures so the rendered root can fail closed', async () => {
    const harness = sessionHarness()
    const failure = new OfficePanelCaptureFailure()
    const capture = startPendingSubmissionCapture({
      expectedSessionId: 'session-1',
      session: harness.session,
      captureSubmission: () => {
        throw new Error('editor disconnected')
      },
      onError: (error) => failure.fail(error),
    })

    harness.publish(['request-a'])
    await Promise.resolve()
    expect(failure.getSnapshot()).toEqual(
      expect.objectContaining({
        message: 'editor disconnected',
      }),
    )
    capture.dispose()
  })
})
