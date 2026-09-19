export interface UndoRedoStatus {
  undos: number
  redos: number
}

export interface RevisionTrackerOptions {
  advance(): void
  suppressed(): boolean
  schedule(run: () => void): void
}

/** Coalesces Univer undo-stack transitions into monotonic document revisions. */
export function createRevisionTracker(options: RevisionTrackerOptions) {
  let previous: string | undefined
  let pending = false

  return {
    observe(status: UndoRedoStatus): void {
      const signature = `${String(status.undos)}:${String(status.redos)}`
      if (signature === previous) return
      const initialized = previous !== undefined
      previous = signature
      if (!initialized || options.suppressed() || pending) return
      pending = true
      options.schedule(() => {
        pending = false
        options.advance()
      })
    },
  }
}
