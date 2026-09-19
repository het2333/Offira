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
      consumeApproval: () => true,
    })

    const result = await (adapter.save as (id: DocumentId, contentVersion?: number) => Promise<unknown>)(documentId, 1)

    expect(result).toMatchObject({ ok: false, warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })] })
  })
})
