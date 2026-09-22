import { describe, expect, it, vi } from 'vitest'
import { createAgentLoopRuntime } from '../src/agent-loop-runtime'
import type { AgentServerFrame } from '@nexusdesk/protocol'

describe('shared Office Harness loop', () => {
  it('reports balance errors in Chinese and resets to a fresh server session', () => {
    let receive!: (frame: AgentServerFrame) => void
    const startTurn = vi.fn()
    const onError = vi.fn()
    const onTurnEnd = vi.fn()
    const runtime = createAgentLoopRuntime({
      transport: {} as never, skill: {} as never,
      getDocumentId: () => 'docs-test', events: { onError, onTurnEnd },
    }, {
      startTurn, cancelTurn: vi.fn(), respondApproval: vi.fn(),
      onFrame: (callback) => { receive = callback; return () => {} },
    })
    runtime.run('连接测试')
    const first = startTurn.mock.calls[0]![0]
    receive({ type: 'agent:event', protocolVersion: 1, sessionId: first.sessionId,
      event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Insufficient Balance' } } } },
    } as AgentServerFrame)
    expect(onError).toHaveBeenCalledWith('DeepSeek 账户余额不足，请充值后重试。')
    expect(runtime.busy).toBe(false)
    expect(onTurnEnd).not.toHaveBeenCalled()
    runtime.reset()
    runtime.run('新对话')
    expect(startTurn.mock.calls[1]![0].sessionId).not.toBe(first.sessionId)
    expect(startTurn.mock.calls[1]![0].documentId).toBe('docs-test')
  })
})
