import { describe, expect, it, vi } from 'vitest'
import type { ApprovedEditPlan, ClientId, DocumentId, EditRequest, OperationId, Revision, SessionId } from '@nexusdesk/protocol'
import { parseAgentToolResult } from '@nexusdesk/protocol'

import { createSlidesEditorAdapter } from '../src/renderer/agent/slides-editor-adapter'

const documentId = 'presentation-1' as DocumentId
const clientId = 'client-1' as ClientId
const revision = 1 as Revision

function request(overrides: Partial<EditRequest> = {}): EditRequest {
  return {
    sessionId: 'session-1' as SessionId,
    documentId,
    clientId,
    editorType: 'slides',
    revision,
    operationId: 'operation-1' as OperationId,
    command: 'apply_ops',
    arguments: { ops: [{ op: 'setText', target: { slide: 0, el: 'title' }, paragraphs: [] }] },
    ...overrides,
  }
}

describe('Slides editor adapter', () => {
  it('describes the exact Slides edit and save in the approval card without API jargon', async () => {
    const adapter = createSlidesEditorAdapter({
      document: () => ({ documentId, clientId, revision, contentVersion: 2, title: 'Deck.pptx', attached: true }),
      read: async () => ({ slides: [] }),
      runTransaction: async () => ({ applied: true }),
      save: async () => undefined, undo: async () => null, redo: async () => null,
      consumeApproval: () => false,
    })
    const edit = await adapter.propose(request({ arguments: { ops: [
      { op: 'setText', target: { slide: 0, el: 'e_3' }, paragraphs: [{ runs: [{ text: '同步刷新验收' }] }] },
      { op: 'setFill', target: { slide: 1, el: 'e_4' }, fill: '#FF0000' },
    ] } }))
    const save = await adapter.proposeSave(request({ command: 'save_presentation', arguments: {} }))

    expect(edit.summary).toContain('第 1 页元素 e_3：文本改为「同步刷新验收」')
    expect(edit.summary).toContain('第 2 页元素 e_4：调整填充')
    expect(edit.summary).not.toContain('Apply 2 presentation operations')
    expect(save.summary).toBe('将当前演示文稿保存到原文件')
  })
  it('provides canonical operation signatures and rejects invalid proposals before approval', async () => {
    const adapter = createSlidesEditorAdapter({
      document: () => ({ documentId, clientId, revision, contentVersion: 1, title: 'Deck.pptx', attached: true }),
      read: async () => ({ slides: [] }),
      validateOperations: async () => { throw new Error('setText requires target and paragraphs') },
      runTransaction: async () => { throw new Error('must not execute during proposal') },
      save: async () => {}, undo: async () => null, redo: async () => null,
      consumeApproval: () => false,
    })
    const read = await adapter.read({ documentId, command: 'read_presentation', arguments: {} })
    expect((read.data as any).operationSignatures).toContain('setText')
    expect((read.data as any).operationSignatures).toContain('paragraphs')
    await expect(adapter.propose(request({ arguments: { ops: [{ op: 'set_text', text: 'bad' }] } }))).rejects.toThrow('requires target')
  })
  it('requires exact one-time approval and replays an applied presentation transaction', async () => {
    const runTransaction = vi.fn().mockResolvedValue({
      applied: true,
      records: [{ op: 'setText', target: '0/title' }],
    })
    const approvals = new Set<string>()
    const adapter = createSlidesEditorAdapter({
      document: () => ({ documentId, clientId, revision, contentVersion: 1, title: 'Deck.pptx', attached: true }),
      read: async () => ({ slides: [{ index: 0, id: 'slide-1', elements: [] }] }),
      runTransaction,
      save: async () => undefined,
      undo: async () => null,
      redo: async () => null,
      consumeApproval(id, hash) {
        const key = `${id}:${hash}`
        if (!approvals.has(key)) return false
        approvals.delete(key)
        return true
      },
    })
    const plan = await adapter.propose(request())
    approvals.add(`approval-1:${plan.planHash}`)

    const first = await adapter.apply({ ...plan, approvalId: 'approval-1' } as ApprovedEditPlan)
    const replay = await adapter.apply({ ...plan, approvalId: 'approval-1' } as ApprovedEditPlan)

    expect(runTransaction).toHaveBeenCalledTimes(1)
    expect(first).toEqual(replay)
    expect(first).toMatchObject({ ok: true, changes: { count: 1 } })
    expect(() => parseAgentToolResult(first)).not.toThrow()
    expect(JSON.stringify(first)).not.toMatch(/engine|electron|webcontents/i)
  })

  it('rejects an approved plan after an unsaved in-memory presentation edit', async () => {
    let contentVersion = 1
    const consumeApproval = vi.fn(() => true)
    const runTransaction = vi.fn().mockResolvedValue({ applied: true, records: [] })
    const adapter = createSlidesEditorAdapter({
      document: () => ({
        documentId,
        clientId,
        revision,
        contentVersion,
        title: 'Deck.pptx',
        attached: true,
      }),
      read: async () => ({ slides: [] }),
      runTransaction,
      save: async () => undefined,
      undo: async () => null,
      redo: async () => null,
      consumeApproval,
    })
    const plan = await adapter.propose(request())
    contentVersion += 1

    const result = await adapter.apply({ ...plan, approvalId: 'approval-1' } as ApprovedEditPlan)

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })],
    })
    expect(consumeApproval).not.toHaveBeenCalled()
    expect(runTransaction).not.toHaveBeenCalled()
  })

  it('rejects a save approval that was prepared for an older in-memory presentation', async () => {
    const adapter = createSlidesEditorAdapter({
      document: () => ({ documentId, clientId, revision, contentVersion: 2, title: 'Deck.pptx', attached: true }),
      read: async () => ({ slides: [] }),
      runTransaction: async () => ({ applied: true }),
      save: async () => undefined,
      undo: async () => null,
      redo: async () => null,
      consumeApproval: () => true,
    })

    const result = await (adapter.save as (id: DocumentId, contentVersion?: number) => Promise<unknown>)(documentId, 1)

    expect(result).toMatchObject({ ok: false, warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })] })
  })

  it.each([
    ['undo', 'Undid the latest presentation change.'],
    ['redo', 'Redid the latest presentation change.'],
  ] as const)('returns an AgentToolResult for approved %s history changes', async (action, summary) => {
    let contentVersion = 3
    const undo = vi.fn().mockResolvedValue({ slides: [], contentVersion: 4 })
    const redo = vi.fn().mockResolvedValue({ slides: [], contentVersion: 4 })
    const adapter = createSlidesEditorAdapter({
      document: () => ({ documentId, clientId, revision, contentVersion, title: 'Deck.pptx', attached: true }),
      read: async () => ({ slides: [] }),
      runTransaction: async () => ({ applied: true }),
      save: async () => undefined,
      undo,
      redo,
      consumeApproval: () => true,
    } as any) as any
    const historyRequest = request({
      command: 'propose_history',
      arguments: { action },
    })
    const plan = await adapter.proposeHistory(historyRequest)
    contentVersion += 1

    const stale = await adapter.applyHistory({ ...plan, approvalId: 'approval-1' })
    expect(stale).toMatchObject({ ok: false, warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })] })

    contentVersion -= 1
    const result = await adapter.applyHistory({ ...plan, approvalId: 'approval-2' })

    expect(action === 'undo' ? undo : redo).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      ok: true,
      summary,
      changes: { targets: ['presentation history'], count: 1 },
      data: { contentVersion: 4 },
    })
    expect(() => parseAgentToolResult(result)).not.toThrow()
  })
})
