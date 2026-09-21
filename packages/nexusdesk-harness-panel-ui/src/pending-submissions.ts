import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { OfficePanelBinding } from './binding.js'

/** The public observable half of a bound Session needed by the admission watcher. */
export interface PendingSubmissionSession {
  getSnapshot(): SessionSnapshot
  subscribe(listener: () => void): () => void
}

export interface PendingSubmissionCaptureOptions {
  readonly expectedSessionId: string
  readonly session: PendingSubmissionSession
  readonly captureSubmission: OfficePanelBinding['captureSubmission']
  readonly onError?: (error: Error) => void
}

export interface PendingSubmissionCapture {
  dispose(): void
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Observable failure latch read by the React root to turn admission failures into UI failure. */
export class OfficePanelCaptureFailure {
  private value: Error | null = null
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): Error | null => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  fail(error: unknown): void {
    if (this.value !== null) return
    this.value = asError(error)
    for (const listener of this.listeners) listener()
  }
}

/**
 * Observe native submission echoes. Their request ids are published in a microtask
 * immediately after beginSubmission(), ahead of the composer's nextPaint() await.
 */
export function startPendingSubmissionCapture(
  options: PendingSubmissionCaptureOptions,
): PendingSubmissionCapture {
  const seen = new Set<string>()
  let disposed = false
  let unsubscribe = (): void => {}

  const captureCurrent = (): void => {
    const snapshot = options.session.getSnapshot()
    if (snapshot.sessionId !== options.expectedSessionId) {
      throw new Error(
        `Office panel expected Session "${options.expectedSessionId}" but observed "${snapshot.sessionId}"`,
      )
    }
    for (const submission of snapshot.pendingSubmissions) {
      const requestId = submission.requestId as string
      if (seen.has(requestId)) continue
      options.captureSubmission(requestId)
      seen.add(requestId)
    }
  }

  const fail = (error: unknown): void => {
    if (disposed) return
    disposed = true
    unsubscribe()
    if (options.onError === undefined) throw asError(error)
    options.onError(asError(error))
  }

  unsubscribe = options.session.subscribe(() => {
    try {
      captureCurrent()
    } catch (error) {
      fail(error)
    }
  })
  try {
    captureCurrent()
  } catch (error) {
    unsubscribe()
    disposed = true
    throw error
  }

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribe()
    },
  }
}
