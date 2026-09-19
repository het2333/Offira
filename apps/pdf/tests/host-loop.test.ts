import { expect, it, vi } from 'vitest'
import { PdfHostLoop } from '../src/renderer/ai/host-loop'
import type { AgentServerFrame } from '@nexusdesk/protocol'

it('routes the visible PDF panel to Harness with streamed answers, exact approvals and cancellation', async () => {
  let listener: (frame: AgentServerFrame) => void = () => {}
  const unsubscribe = vi.fn()
  const api = {
    startTurn: vi.fn(),
    cancelTurn: vi.fn(),
    respondApproval: vi.fn(),
    onFrame: vi.fn((fn) => {
      listener = fn
      return unsubscribe
    }),
  }
  const events = { onText: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onToolExecuted: vi.fn() }
  const confirm = vi.fn().mockResolvedValue(true)
  const loop = new PdfHostLoop(api, () => 'pdf-1', events, confirm)
  loop.run('Insert a blank page.')
  const sessionId = api.startTurn.mock.calls[0]![0].sessionId
  expect(api.startTurn).toHaveBeenCalledWith({
    sessionId,
    documentId: 'pdf-1',
    prompt: 'Insert a blank page.',
  })
  expect(loop.busy).toBe(true)
  const proposal = {
    planHash: 'exact-hash',
    snapshotHash: 'snapshot',
    operationId: 'op-1',
    summary: 'Insert blank page',
    targets: ['current PDF'],
    warnings: [],
  }
  listener({
    type: 'approval:request',
    id: 'approval-1',
    sessionId,
    toolName: 'modify_pdf_pages',
    proposal,
  } as never)
  await vi.waitFor(() =>
    expect(api.respondApproval).toHaveBeenCalledWith('approval-1', 'allowed-once'),
  )
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ proposal }))
  listener({
    type: 'agent:event',
    sessionId,
    event: { type: 'stream/chunk', data: { type: 'text-delta', text: 'Saved.' } },
  } as never)
  listener({
    type: 'agent:event',
    sessionId,
    event: {
      type: 'tool/result',
      data: { callId: 'tool-1', name: 'modify_pdf_pages', contentText: 'Applied' },
    },
  } as never)
  expect(events.onText).toHaveBeenCalledWith('Saved.')
  expect(events.onToolExecuted).toHaveBeenCalledWith(
    expect.objectContaining({ execution: expect.objectContaining({ mutated: false }) }),
  )
  loop.cancel()
  expect(api.cancelTurn).toHaveBeenCalledWith(sessionId)
  listener({
    type: 'agent:event',
    sessionId,
    event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  } as never)
  expect(loop.busy).toBe(false)
  expect(events.onDone).toHaveBeenCalledWith({ text: 'Saved.', cancelled: false, turnLimit: false })
  loop.dispose()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('rejects a delayed approval after the visible conversation is reset', async () => {
  let listener: (frame: AgentServerFrame) => void = () => {}
  let settle: (approved: boolean) => void = () => {}
  const api = {
    startTurn: vi.fn(),
    cancelTurn: vi.fn(),
    respondApproval: vi.fn(),
    onFrame: vi.fn((fn) => {
      listener = fn
      return () => {}
    }),
  }
  const loop = new PdfHostLoop(
    api,
    () => 'pdf-1',
    {},
    () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  )
  loop.run('Edit')
  const sessionId = api.startTurn.mock.calls[0]![0].sessionId
  listener({
    type: 'approval:request',
    id: 'approval-1',
    sessionId,
    toolName: 'update_pdf_annotation',
  } as never)
  loop.reset()
  settle(true)
  await vi.waitFor(() => expect(api.respondApproval).toHaveBeenCalledWith('approval-1', 'rejected'))
  loop.dispose()
})
