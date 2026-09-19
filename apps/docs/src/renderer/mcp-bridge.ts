import type { McpCommandMessage } from '../shared/ipc'
import { executeDocsCommand } from './agent/docs-command-executor'
import type { FileActionContext } from './file-actions'

/**
 * MCP bridge (renderer half).
 *
 * The shell main process pushes editor commands over `docs:mcp-command`; this
 * module runs them against the *live* Tiptap editor so an external agent drives
 * the same visible editor the built-in agent does, then reports the outcome
 * back on `docs:mcp-result`. Command execution is serialized so a burst cannot
 * interleave two edits into one document.
 *
 * The executors are the built-in agent's own (`executeTool`), so external edits
 * inherit the same parsing, atomicity, formatting rules and stale-index guard.
 */

export interface McpBridgeDeps {
  /** live file-action context (refreshed every render by App) */
  getCtx: () => FileActionContext
}

/**
 * A fresh tab boots asynchronously (`newFile()` calls setContent, then setDoc),
 * so a command that lands before `doc` exists would be wiped by that blank
 * reset. Wait for the loaded document before announcing readiness.
 *
 * The wait never stops retrying, only slows down: a tab that gave up while its
 * renderer was still booting would look fine in the UI yet stay unaddressable
 * over MCP for the rest of its life, because readiness is announced exactly
 * once and never re-derived.
 */
const READY_POLL_MS = 50
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000

async function announceWhenLoaded(
  deps: McpBridgeDeps,
  signal: () => void,
  isCancelled: () => boolean,
): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    if (isCancelled()) return
    const ctx = deps.getCtx()
    if (ctx?.editor && ctx.doc) {
      signal()
      return
    }
    const slow = Date.now() - startedAt > READY_FAST_WINDOW_MS
    await new Promise((resolve) => setTimeout(resolve, slow ? READY_SLOW_POLL_MS : READY_POLL_MS))
  }
}

/** Subscribe the live editor to MCP commands. Returns the unsubscribe function. */
export function installMcpBridge(deps: McpBridgeDeps): () => void {
  const desktop = window.desktop
  if (!desktop?.onMcpCommand || !desktop.reportMcpResult) return () => {}
  let cancelled = false
  let queue: Promise<void> = Promise.resolve()
  const unsubscribe = desktop.onMcpCommand((message: McpCommandMessage) => {
    if (!message || typeof message.requestId !== 'string') return
    queue = queue.then(async () => {
      try {
        const outcome = await executeDocsCommand(deps.getCtx(), message.command, message.payload)
        if (outcome.ok) {
          desktop.reportMcpResult({ requestId: message.requestId, ok: true, result: outcome.result })
        } else {
          desktop.reportMcpResult({ requestId: message.requestId, ok: false, error: outcome.error })
        }
      } catch (error) {
        desktop.reportMcpResult({ requestId: message.requestId, ok: false, error: String(error) })
      }
    })
  })
  // Let the shell know this tab can accept commands (device for targeted routing).
  void announceWhenLoaded(
    deps,
    () => desktop.signalMcpReady?.(),
    () => cancelled,
  )
  return () => {
    cancelled = true
    unsubscribe()
  }
}
