import { describe, expect, it, vi } from 'vitest'
import type { ApprovedEditPlan, EditRequest } from '@nexusdesk/protocol'

import { createHtmlEditorAdapter } from '../src/renderer/agent/html-editor-adapter'

const request: EditRequest = {
  sessionId: 'session-1' as never,
  documentId: 'html-1' as never,
  editorType: 'html',
  revision: 1 as never,
  operationId: 'operation-1' as never,
  clientId: 'client-1' as never,
  command: 'apply_ops',
  arguments: { ops: [{ op: 'set_text', sid: 1, text: 'Approved' }] },
}

function harness() {
  let contentVersion = 1
  const approvals = new Map<string, string>()
  const apply = vi.fn().mockResolvedValue({ ok: true, summary: 'Applied.', warnings: [] })
  const consumeApproval = vi.fn((id: string, hash: string) => {
    if (approvals.get(id) !== hash) return false
    approvals.delete(id)
    return true
  })
  const adapter = createHtmlEditorAdapter({
    document: () => ({
      documentId: 'html-1' as never,
      clientId: 'client-1' as never,
      revision: 1 as never,
      contentVersion,
      title: 'Page.html',
      attached: true,
    }),
    read: () => ({ ok: true, summary: 'Read HTML.', warnings: [] }),
    apply,
    save: vi.fn(),
    consumeApproval,
  })
  return { adapter, apply, approvals, consumeApproval, change: () => { contentVersion += 1 } }
}

describe('HTML editor adapter', () => {
  it('applies one exact approved plan once and replays its result', async () => {
    const { adapter, apply, approvals } = harness()
    const plan = await adapter.propose(request)
    approvals.set('approval-1', plan.planHash)
    const approved = { ...plan, approvalId: 'approval-1' } as ApprovedEditPlan

    const first = await adapter.apply(approved)
    const replay = await adapter.apply(approved)

    expect(first).toEqual(replay)
    expect(first).toMatchObject({ ok: true, changes: { count: 1 }, verification: { passed: true } })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale in-memory working copy before consuming approval', async () => {
    const { adapter, apply, approvals, consumeApproval, change } = harness()
    const plan = await adapter.propose(request)
    approvals.set('approval-1', plan.planHash)
    change()

    const result = await adapter.apply({ ...plan, approvalId: 'approval-1' })

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })],
    })
    expect(consumeApproval).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('rejects a working copy that changes while approval is being consumed', async () => {
    let releaseApproval!: () => void
    const approvalPending = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    let approvalStarted!: () => void
    const approvalStart = new Promise<void>((resolve) => {
      approvalStarted = resolve
    })
    let contentVersion = 1
    const apply = vi.fn().mockResolvedValue({ ok: true, summary: 'Applied.', warnings: [] })
    const adapter = createHtmlEditorAdapter({
      document: () => ({
        documentId: 'html-1' as never,
        clientId: 'client-1' as never,
        revision: 1 as never,
        contentVersion,
        title: 'Page.html',
        attached: true,
      }),
      read: () => ({ ok: true, summary: 'Read HTML.', warnings: [] }),
      apply,
      save: vi.fn(),
      consumeApproval: vi.fn(async () => {
        approvalStarted()
        await approvalPending
        return true
      }),
    })
    const plan = await adapter.propose(request)

    const resultPending = adapter.apply({ ...plan, approvalId: 'approval-1' })
    await approvalStart
    contentVersion += 1
    releaseApproval()
    const result = await resultPending

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })],
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('rejects plan tampering after exact approval', async () => {
    const { adapter, apply, approvals } = harness()
    const plan = await adapter.propose(request)
    approvals.set('approval-1', plan.planHash)

    const result = await adapter.apply({
      ...plan,
      approvalId: 'approval-1',
      operations: [{ op: 'remove', sid: 1 }],
    })

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'PLAN_TAMPERED' })],
    })
    expect(apply).not.toHaveBeenCalled()
  })
})
