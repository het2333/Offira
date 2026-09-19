import { describe, expect, it, vi } from 'vitest'

import { createRevisionTracker } from '../src/renderer/agent/revision-tracker'

describe('NexusDesk editor revision tracker', () => {
  it('advances once for a committed edit batch and for undo/redo transitions', () => {
    const advance = vi.fn()
    const queued: Array<() => void> = []
    const tracker = createRevisionTracker({
      advance,
      schedule: (run) => queued.push(run),
      suppressed: () => false,
    })

    tracker.observe({ undos: 0, redos: 0 })
    tracker.observe({ undos: 1, redos: 0 })
    tracker.observe({ undos: 2, redos: 0 })
    expect(advance).not.toHaveBeenCalled()
    queued.shift()?.()
    expect(advance).toHaveBeenCalledTimes(1)

    tracker.observe({ undos: 1, redos: 1 })
    queued.shift()?.()
    tracker.observe({ undos: 2, redos: 0 })
    queued.shift()?.()
    expect(advance).toHaveBeenCalledTimes(3)
  })

  it('ignores programmatic load mutations while journal suppression is active', () => {
    const advance = vi.fn()
    const queued: Array<() => void> = []
    let suppressed = true
    const tracker = createRevisionTracker({
      advance,
      schedule: (run) => queued.push(run),
      suppressed: () => suppressed,
    })

    tracker.observe({ undos: 0, redos: 0 })
    tracker.observe({ undos: 1, redos: 0 })
    suppressed = false
    tracker.observe({ undos: 2, redos: 0 })
    queued.shift()?.()

    expect(advance).toHaveBeenCalledTimes(1)
  })
})
