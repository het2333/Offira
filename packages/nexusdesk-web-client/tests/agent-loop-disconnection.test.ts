import { describe, expect, it, vi } from 'vitest'
import { createAgentLoopRuntime } from '../src/agent-loop-runtime'
import type { AgentServerFrame } from '@nexusdesk/protocol'

describe('Office chat disconnection regressions', () => {
  it('ends waiting on recovery-required without waiting for a terminal model event', () => {
    let receive!: (frame: AgentServerFrame) => void
    const onError = vi.fn()
    const runtime = createAgentLoopRuntime({ transport: {} as never, skill: {} as never,
      getDocumentId: () => 'sheets-test', events: { onError },
    }, { startTurn: vi.fn(), cancelTurn: vi.fn(), respondApproval: vi.fn(),
      onFrame: (callback) => { receive = callback; return () => {} },
    })
    runtime.run('计算和')
    receive({ type: 'recovery:required', protocolVersion: 1, id: 'recovery-test',
      documentId: 'sheets-test', code: 'DOCUMENT_DETACHED', message: 'no browser client',
    } as AgentServerFrame)
    expect(runtime.busy).toBe(false)
    expect(onError).toHaveBeenCalled()
  })
  function fixture(startTurn = vi.fn(), cancelTurn = vi.fn()) {
    const onError = vi.fn()
    const runtime = createAgentLoopRuntime({
      transport: {} as never, skill: {} as never,
      getDocumentId: () => 'sheets-disconnection-test', events: { onError },
    }, {
      startTurn, cancelTurn, respondApproval: vi.fn(), onFrame: () => () => {},
    })
    return { runtime, onError }
  }

  it('settles the spinner and reports a failed send instead of throwing', () => {
    const { runtime, onError } = fixture(vi.fn(() => { throw new Error('CONNECTION_LOST') }))
    expect(() => runtime.run('计算选区的和')).not.toThrow()
    expect(runtime.busy).toBe(false)
    expect(onError).toHaveBeenCalled()
  })

  it('settles locally when cancel cannot reach the disconnected host', () => {
    const { runtime, onError } = fixture(vi.fn(), vi.fn(() => { throw new Error('CONNECTION_LOST') }))
    runtime.run('计算选区的和')
    expect(() => runtime.cancel()).not.toThrow()
    expect(runtime.busy).toBe(false)
    expect(onError).toHaveBeenCalled()
  })
})
