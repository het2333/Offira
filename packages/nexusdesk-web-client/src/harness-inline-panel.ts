import { mountInlineHarness } from '@nexusdesk/harness-office-panel-ui/inline'
import { createHarnessTransport } from './harness-transport'
import type { MountHarnessPanelOptions } from './harness-panel'

/** Official UI mounted in the caller's DOM, using the existing document socket. */
export async function mountInlineOfficePanel(options: MountHarnessPanelOptions): Promise<() => void> {
  const transport = createHarnessTransport(options.client, options.documentId)
  const abort = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal
  signal.addEventListener('abort', () => transport.dispose(), { once: true })
  try {
    signal.throwIfAborted()
    const sessionId = await transport.bind()
    signal.throwIfAborted()
    const params = new URLSearchParams({ clientId: options.clientId, documentId: options.documentId })
    const handle = await mountInlineHarness({
      container: options.container, signal, rpc: transport.rpc,
      bootstrapUrl: `/harness/boot.json?${params}`,
      binding: { sessionId, connection: transport.connection,
        ...(options.subscribeDraftRequests ? { subscribeDraftRequests: options.subscribeDraftRequests } : {}), captureSubmission(requestId) {
        transport.captureSubmission(requestId, structuredClone(options.captureSnapshot()))
      } },
      onFailure() { /* The editor owns the user-facing error presentation. */ },
    })
    signal.addEventListener('abort', () => { transport.dispose(); void handle.dispose() }, { once: true })
    return () => { abort.abort() }
  } catch (error) {
    abort.abort()
    transport.dispose()
    throw error
  }
}
