import type { McpCommandMessage } from '../shared/desktop-api'
import {
  executeSheetsCommand,
  type McpSheetHandlers,
} from './agent/sheets-command'

export type { McpSheetHandlers } from './agent/sheets-command'

/**
 * Compatibility transport for the existing desktop MCP channel. Command
 * semantics live in the transport-neutral NexusDesk Sheets command module.
 */
const READY_POLL_MS = 50
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000

export function installSheetsMcpBridge(handlers: McpSheetHandlers): () => void {
  const api = window.desktopApi
  if (typeof api?.onMcpCommand !== 'function') return () => {}

  let queue: Promise<void> = Promise.resolve()
  let disposed = false
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  const mountedAt = performance.now()
  const announceWhenMounted = (): void => {
    readyTimer = null
    if (disposed) return
    if (handlers.hasWorkbook()) {
      api.signalMcpReady()
      return
    }
    const slow = performance.now() - mountedAt > READY_FAST_WINDOW_MS
    readyTimer = setTimeout(announceWhenMounted, slow ? READY_SLOW_POLL_MS : READY_POLL_MS)
  }
  readyTimer = setTimeout(announceWhenMounted, READY_POLL_MS)

  const off = api.onMcpCommand((message: McpCommandMessage) => {
    queue = queue.then(async () => {
      const result = await executeSheetsCommand(handlers, {
        command: message.command,
        arguments: (message.payload ?? {}) as Record<string, unknown>,
      })
      api.reportMcpResult({
        requestId: message.requestId,
        ok: result.ok,
        ...(result.ok
          ? { result: result.data ?? result }
          : { error: result.warnings[0]?.message ?? result.summary }),
      })
    }).catch((error: unknown) => {
      api.reportMcpResult({
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })

  return () => {
    disposed = true
    if (readyTimer !== null) clearTimeout(readyTimer)
    off()
  }
}
