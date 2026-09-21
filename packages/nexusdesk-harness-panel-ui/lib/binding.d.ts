/** Authenticated carrier capability consumed by the Office-only Client plugin. */
export interface OfficePanelBinding {
    readonly sessionId: string;
    captureSubmission(requestId: string): void;
}
/**
 * Install the browser capability before AppWebEntry starts the native Client graph.
 * The returned disposer can only clear the exact installation it created.
 */
export declare function installOfficePanelBinding(binding: OfficePanelBinding): () => void;
/** Resolve the authenticated capability or reject Client activation. */
export declare function requireOfficePanelBinding(): OfficePanelBinding;
