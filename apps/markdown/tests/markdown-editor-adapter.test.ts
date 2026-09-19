import { describe, expect, it, vi } from 'vitest'
import type { ApprovedEditPlan, EditRequest } from '@nexusdesk/protocol'

import { createMarkdownEditorAdapter } from '../src/renderer/agent/markdown-editor-adapter'

const baseRequest: EditRequest = {
  sessionId: 'session-1' as never,
  documentId: 'markdown-1' as never,
  editorType: 'markdown',
  revision: 1 as never,
  operationId: 'operation-1' as never,
  clientId: 'client-1' as never,
  command: 'apply_ops',
  arguments: { ops: [{ op: 'replaceText', find: 'Initial', replace: 'Approved' }] },
}

describe('Markdown editor adapter', () => {
  it('proposes without applying, then applies exactly once after matching approval', async () => {
    const apply = vi.fn().mockResolvedValue({ ok: true, summary: 'Applied one operation.', warnings: [] })
    const approvals = new Map<string, string>()
    const adapter = createMarkdownEditorAdapter({
      document: () => ({
        documentId: 'markdown-1' as never,
        clientId: 'client-1' as never,
        revision: 1 as never,
        title: 'Notes.md',
        attached: true,
      }),
      read: () => ({ ok: true, summary: 'Read Markdown.', warnings: [], data: { text: '# Initial' } }),
      apply,
      save: vi.fn().mockResolvedValue({ ok: true, summary: 'Saved.', warnings: [] }),
      consumeApproval(id, hash) {
        if (approvals.get(id) !== hash) return false
        approvals.delete(id)
        return true
      },
    })

    const plan = await adapter.propose(baseRequest)
    expect(apply).not.toHaveBeenCalled()
    approvals.set('approval-1', plan.planHash)
    const approved = { ...plan, approvalId: 'approval-1' } as ApprovedEditPlan

    const first = await adapter.apply(approved)
    const replay = await adapter.apply(approved)
    expect(first).toEqual(replay)
    expect(first).toMatchObject({ ok: true, changes: { count: 1 }, verification: { passed: true } })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(baseRequest.arguments.ops)
  })

  it('rejects a stale plan before consuming approval or mutating', async () => {
    const apply = vi.fn()
    const consumeApproval = vi.fn(() => true)
    const adapter = createMarkdownEditorAdapter({
      document: () => ({
        documentId: 'markdown-1' as never,
        clientId: 'client-1' as never,
        revision: 2 as never,
        title: 'Notes.md',
        attached: true,
      }),
      read: () => ({ ok: true, summary: 'Read Markdown.', warnings: [] }),
      apply,
      save: vi.fn(),
      consumeApproval,
    })
    const plan = await adapter.propose(baseRequest)
    const result = await adapter.apply({ ...plan, approvalId: 'approval-1' })
    expect(result).toMatchObject({ ok: false, warnings: [expect.objectContaining({ code: 'STALE_REVISION' })] })
    expect(consumeApproval).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('rejects a plan after a manual editor change even when the Host revision is unchanged', async () => {
    let contentVersion = 1
    const apply = vi.fn()
    const consumeApproval = vi.fn(() => true)
    const adapter = createMarkdownEditorAdapter({
      document: () => ({
        documentId: 'markdown-1' as never, clientId: 'client-1' as never, revision: 1 as never,
        contentVersion, title: 'Notes.md', attached: true,
      }),
      read: () => ({ ok: true, summary: 'Read Markdown.', warnings: [] }), apply, save: vi.fn(), consumeApproval,
    })

    const plan = await adapter.propose(baseRequest)
    contentVersion = 2
    const result = await adapter.apply({ ...plan, approvalId: 'approval-1' })

    expect(result).toMatchObject({ ok: false, warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })] })
    expect(consumeApproval).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('rejects a proposal after a frontmatter edit advances the content version', async () => {
    let contentVersion = 4
    const apply = vi.fn()
    const consumeApproval = vi.fn(() => true)
    const adapter = createMarkdownEditorAdapter({
      document: () => ({
        documentId: 'markdown-1' as never,
        clientId: 'client-1' as never,
        revision: 1 as never,
        contentVersion,
        title: 'Notes.md',
        attached: true,
      }),
      read: () => ({ ok: true, summary: 'Read Markdown.', warnings: [] }),
      apply,
      save: vi.fn(),
      consumeApproval,
    })
    const plan = await adapter.propose(baseRequest)

    contentVersion += 1
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
    const adapter = createMarkdownEditorAdapter({
      document: () => ({
        documentId: 'markdown-1' as never,
        clientId: 'client-1' as never,
        revision: 1 as never,
        contentVersion,
        title: 'Notes.md',
        attached: true,
      }),
      read: () => ({ ok: true, summary: 'Read Markdown.', warnings: [] }),
      apply,
      save: vi.fn(),
      consumeApproval: vi.fn(async () => {
        approvalStarted()
        await approvalPending
        return true
      }),
    })
    const plan = await adapter.propose(baseRequest)

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
})
