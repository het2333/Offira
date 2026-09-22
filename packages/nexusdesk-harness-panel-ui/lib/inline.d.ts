import { type OfficePanelBinding } from './binding';
export interface InlineHarnessOptions {
    container: HTMLElement;
    signal: AbortSignal;
    onFailure(error: unknown): void;
    bootstrapUrl: string;
    binding: OfficePanelBinding;
    rpc: object;
    fetch?: typeof fetch;
}
export interface InlineHarnessHandle {
    dispose(): Promise<void>;
}
/** Mount the official application into the editor-owned sidebar, never a document root. */
export declare function mountInlineHarness(options: InlineHarnessOptions): Promise<InlineHarnessHandle>;
