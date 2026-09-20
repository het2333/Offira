import { CustomCommandExecutionError, ICommandService } from '@univerjs/core'
import type { UniverRuntime } from './univer-state'

const locked = new WeakSet<UniverRuntime>()
let installationDepth = 0

/** Synchronous trusted file installation only; never hold this across an await. */
export function enterWorkbookInstallation(): () => void {
  installationDepth++
  return () => {
    installationDepth--
  }
}

export function withWorkbookInstallation<T>(install: () => T): T {
  const leave = enterWorkbookInstallation()
  try {
    return install()
  } finally {
    leave()
  }
}

export function isApprovedSaveLocked(runtime: UniverRuntime | null): boolean {
  return runtime !== null && locked.has(runtime)
}

/** Prevent edits (including delayed command dispatches) throughout the disk transaction. */
export function lockApprovedSave(runtime: UniverRuntime | null): () => void {
  if (runtime && locked.has(runtime)) throw Error('An approved save is already in progress')
  // Include portalled dialogs, not only the React root.
  const root = typeof document === 'undefined' ? null : document.body
  const wasInert = root?.inert ?? false
  const service = runtime?.univer.__getInjector().get(ICommandService)
  const subscription = service?.beforeCommandExecuted((command) => {
    if (installationDepth > 0) return
    // Like the calculation veto, remove the dispatch entry before throwing:
    // Univer only balances this stack on its successful execution path.
    const stack = (service as unknown as { _commandExecutionStack?: unknown[] })
      ._commandExecutionStack
    const index = stack?.indexOf(command) ?? -1
    if (index >= 0) stack?.splice(index, 1)
    throw new CustomCommandExecutionError('An approved save is in progress')
  })
  if (runtime) locked.add(runtime)
  if (root) root.inert = true
  let released = false
  return () => {
    if (released) return
    released = true
    subscription?.dispose()
    if (runtime) locked.delete(runtime)
    if (root) root.inert = wasInert
  }
}
