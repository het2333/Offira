import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
import type { OfficePanelBinding } from './binding.js';
/** The public observable half of a bound Session needed by the admission watcher. */
export interface PendingSubmissionSession {
    getSnapshot(): SessionSnapshot;
    subscribe(listener: () => void): () => void;
}
export interface PendingSubmissionCaptureOptions {
    readonly expectedSessionId: string;
    readonly session: PendingSubmissionSession;
    readonly captureSubmission: OfficePanelBinding['captureSubmission'];
    readonly onError?: (error: Error) => void;
}
export interface PendingSubmissionCapture {
    dispose(): void;
}
/** Observable failure latch read by the React root to turn admission failures into UI failure. */
export declare class OfficePanelCaptureFailure {
    private value;
    private readonly listeners;
    getSnapshot: () => Error | null;
    subscribe: (listener: () => void) => (() => void);
    fail(error: unknown): void;
}
/**
 * Observe native submission echoes. Their request ids are published in a microtask
 * immediately after beginSubmission(), ahead of the composer's nextPaint() await.
 */
export declare function startPendingSubmissionCapture(options: PendingSubmissionCaptureOptions): PendingSubmissionCapture;
