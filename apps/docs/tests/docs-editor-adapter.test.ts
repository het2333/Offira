import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import {
  parseAgentToolResult,
  type ApprovedEditPlan,
  type ClientId,
  type DocumentId,
  type EditRequest,
  type OperationId,
  type Revision,
  type SessionId,
} from '@nexusdesk/protocol'

import { createDocsEditorAdapter } from '../src/renderer/agent/docs-editor-adapter'
import { editorExtensions } from '../src/renderer/editor/extensions'
import type { FileActionContext } from '../src/renderer/file-actions'

const documentId = 'document-1' as DocumentId
const clientId = 'client-1' as ClientId
const revision = 1 as Revision
const liveEditors: Editor[] = []

function createContext(text = 'Original text.'): FileActionContext {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null },
          content: [{ type: 'text', text }],
        },
      ],
    },
  })
  liveEditors.push(editor)
  return {
    editor,
    doc: {
      parsed: { blocks: [] },
      filePath: 'nexusdesk://document-1',
      fileName: 'Example.docx',
      hash: 'hash-1',
    },
  } as unknown as FileActionContext
}

function editRequest(overrides: Partial<EditRequest> = {}): EditRequest {
  return {
    sessionId: 'session-1' as SessionId,
    documentId,
    editorType: 'docs',
    revision,
    operationId: 'operation-1' as OperationId,
    clientId,
    command: 'apply_ops',
    arguments: { ops: [{ op: 'findReplace', find: 'Original', replace: 'Approved' }] },
    ...overrides,
  }
}

function liveDocumentState() {
  return {
    documentId,
    clientId,
    revision,
    title: 'Example.docx',
    attached: true,
  }
}

function setup() {
  const ctx = createContext()
  const approvals = new Map<string, string>()
  const adapter = createDocsEditorAdapter({
    context: () => ctx,
    document: () => ({ documentId, clientId, revision, title: 'Example.docx', attached: true }),
    consumeApproval(approvalId, planHash) {
      if (approvals.get(approvalId) !== planHash) return false
      approvals.delete(approvalId)
      return true
    },
  })
  return { adapter, approvals, ctx }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const editor of liveEditors.splice(0)) editor.destroy()
})

describe('Docs editor adapter', () => {
  it('proposes a canonical bounded plan without mutating the document', async () => {
    const { adapter, ctx } = setup()
    const before = ctx.editor?.state.doc.textContent

    const plan = await adapter.propose(editRequest())

    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.operations).toEqual([{ op: 'findReplace', find: 'Original', replace: 'Approved' }])
    expect(plan.summary).toContain('1')
    expect(ctx.editor?.state.doc.textContent).toBe(before)
  })

  it('binds the plan hash to the exact unsaved editor content', async () => {
    const { adapter, ctx } = setup()
    const beforeEdit = await adapter.propose(editRequest())

    const editor = ctx.editor!
    editor.view.dispatch(editor.state.tr.insertText(' Typed.', editor.state.doc.content.size - 1))
    const afterEdit = await adapter.propose(editRequest())

    expect(afterEdit.planHash).not.toBe(beforeEdit.planHash)
  })

  it('binds the plan hash to a monotonic content generation after edit and undo', async () => {
    const { adapter, ctx } = setup()
    const beforeEdit = await adapter.propose(editRequest())
    const editor = ctx.editor!

    editor.view.dispatch(
      editor.state.tr.insertText(' Temporary.', editor.state.doc.content.size - 1),
    )
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.textContent).toBe('Original text.')
    const afterUndo = await adapter.propose(editRequest())

    expect(afterUndo.planHash).not.toBe(beforeEdit.planHash)
  })

  it('binds apply to an exact one-time approval and replays by operation id', async () => {
    const { adapter, approvals, ctx } = setup()
    const plan = await adapter.propose(editRequest())

    const unapproved = await adapter.apply({
      ...plan,
      planHash: 'wrong',
      approvalId: 'approval-1',
    } as ApprovedEditPlan)
    expect(unapproved).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'APPROVAL_INVALID' })],
    })

    approvals.set('approval-1', plan.planHash)
    const approved = { ...plan, approvalId: 'approval-1' } as ApprovedEditPlan
    const first = await adapter.apply(approved)
    const replayed = await adapter.apply(approved)

    expect(first).toEqual(replayed)
    expect(first).toMatchObject({
      ok: true,
      changes: { count: 1 },
      transactionId: expect.any(String),
      verification: { passed: true, issues: [] },
    })
    expect(ctx.editor?.state.doc.textContent).toBe('Approved text.')
    expect(approvals.has('approval-1')).toBe(false)
    expect(() => parseAgentToolResult(first)).not.toThrow()
    expect(JSON.stringify(first)).not.toMatch(/engine|tiptap|prosemirror/i)
  })

  it('rejects stale revisions before consuming approval or editing', async () => {
    const ctx = createContext()
    const consumeApproval = vi.fn(() => true)
    const adapter = createDocsEditorAdapter({
      context: () => ctx,
      document: () => ({
        documentId,
        clientId,
        revision: 2 as Revision,
        title: 'Example.docx',
        attached: true,
      }),
      consumeApproval,
    })
    const plan = await adapter.propose(editRequest())

    const result = await adapter.apply({ ...plan, approvalId: 'approval-1' })

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'STALE_REVISION' })],
    })
    expect(consumeApproval).not.toHaveBeenCalled()
    expect(ctx.editor?.state.doc.textContent).toBe('Original text.')
  })

  it.each([
    {
      change: 'typing',
      prepare: (_editor: Editor) => undefined,
      mutate(editor: Editor) {
        editor.view.dispatch(
          editor.state.tr.insertText(' Typed.', editor.state.doc.content.size - 1),
        )
      },
      expected: 'Original text. Typed.',
    },
    {
      change: 'pasting',
      prepare: (_editor: Editor) => undefined,
      mutate(editor: Editor) {
        const transaction = editor.state.tr
          .insertText(' Pasted.', editor.state.doc.content.size - 1)
          .setMeta('paste', true)
          .setMeta('uiEvent', 'paste')
        editor.view.dispatch(transaction)
      },
      expected: 'Original text. Pasted.',
    },
    {
      change: 'undoing',
      prepare(editor: Editor) {
        editor.view.dispatch(
          editor.state.tr.insertText(' Draft.', editor.state.doc.content.size - 1),
        )
      },
      mutate(editor: Editor) {
        expect(editor.commands.undo()).toBe(true)
      },
      expected: 'Original text.',
    },
  ])(
    'rejects an approved plan after $change changes the unsaved editor content',
    async ({ prepare, mutate, expected }) => {
      const { adapter, approvals, ctx } = setup()
      const editor = ctx.editor!
      prepare(editor)
      const plan = await adapter.propose(editRequest())
      approvals.set('approval-1', plan.planHash)

      mutate(editor)
      const result = await adapter.apply({ ...plan, approvalId: 'approval-1' })

      expect(result).toMatchObject({
        ok: false,
        warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })],
      })
      expect(approvals.has('approval-1')).toBe(true)
      expect(editor.state.doc.textContent).toBe(expected)
    },
  )

  it('rejects an old plan after the editor changes and undoes back to identical JSON', async () => {
    const { adapter, approvals, ctx } = setup()
    const plan = await adapter.propose(editRequest())
    approvals.set('approval-1', plan.planHash)
    const editor = ctx.editor!

    editor.view.dispatch(
      editor.state.tr.insertText(' Temporary.', editor.state.doc.content.size - 1),
    )
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.textContent).toBe('Original text.')
    const result = await adapter.apply({ ...plan, approvalId: 'approval-1' })

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })],
    })
    expect(approvals.has('approval-1')).toBe(true)
    expect(editor.state.doc.textContent).toBe('Original text.')
  })

  it('counts CaretMarksMemory appended document changes when root transactions do not change the doc', async () => {
    const { adapter, approvals, ctx } = setup()
    const editor = ctx.editor!
    expect(
      editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'docParagraph' }),
    ).toBe(true)
    expect(editor.commands.setTextSelection(editor.state.doc.content.size - 1)).toBe(true)
    const textStyle = editor.schema.marks.docTextStyle.create({
      font: 'Calibri',
      sizeHalfPoints: 24,
    })
    editor.view.dispatch(editor.state.tr.setStoredMarks([textStyle]))
    const before = editor.getJSON()
    const plan = await adapter.propose(editRequest())
    approvals.set('approval-1', plan.planHash)
    const transactions: Array<{ rootChanged: boolean; appendedChanged: boolean }> = []
    editor.on('transaction', ({ transaction, appendedTransactions }) => {
      transactions.push({
        rootChanged: transaction.docChanged,
        appendedChanged: appendedTransactions.some((appended) => appended.docChanged),
      })
    })

    editor.view.dispatch(editor.state.tr.setStoredMarks([]))
    editor.view.dispatch(editor.state.tr.setStoredMarks([textStyle]))
    expect(transactions).toEqual([
      { rootChanged: false, appendedChanged: true },
      { rootChanged: false, appendedChanged: true },
    ])
    expect(editor.getJSON()).toEqual(before)
    const result = await adapter.apply({ ...plan, approvalId: 'approval-1' })

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })],
    })
    expect(approvals.has('approval-1')).toBe(true)
    expect(editor.state.doc.textContent).toBe('Original text.')
  })

  it('rechecks unsaved editor content after asynchronous approval consumption', async () => {
    const ctx = createContext()
    let approvalStarted!: () => void
    const started = new Promise<void>((resolve) => {
      approvalStarted = resolve
    })
    let releaseApproval!: () => void
    const pendingApproval = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    const adapter = createDocsEditorAdapter({
      context: () => ctx,
      document: () => ({ documentId, clientId, revision, title: 'Example.docx', attached: true }),
      async consumeApproval() {
        approvalStarted()
        await pendingApproval
        return true
      },
    })
    const plan = await adapter.propose(editRequest())

    const resultPending = adapter.apply({ ...plan, approvalId: 'approval-1' })
    await started
    const editor = ctx.editor!
    editor.view.dispatch(editor.state.tr.insertText(' Typed.', editor.state.doc.content.size - 1))
    releaseApproval()
    const result = await resultPending

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'STALE_CONTENT' })],
    })
    expect(editor.state.doc.textContent).toBe('Original text. Typed.')
  })

  it.each([
    {
      change: 'attachment',
      mutate: (state: ReturnType<typeof liveDocumentState>) => {
        state.attached = false
      },
      code: 'DOCUMENT_DETACHED',
    },
    {
      change: 'document identity',
      mutate: (state: ReturnType<typeof liveDocumentState>) => {
        state.documentId = 'document-2' as DocumentId
      },
      code: 'DOCUMENT_NOT_FOUND',
    },
    {
      change: 'client identity',
      mutate: (state: ReturnType<typeof liveDocumentState>) => {
        state.clientId = 'client-2' as ClientId
      },
      code: 'WRONG_CLIENT',
    },
    {
      change: 'disk revision',
      mutate: (state: ReturnType<typeof liveDocumentState>) => {
        state.revision = 2 as Revision
      },
      code: 'STALE_REVISION',
    },
  ])(
    'synchronously rechecks $change after the final snapshot hash await',
    async ({ mutate, code }) => {
      const ctx = createContext()
      const state = liveDocumentState()
      let releaseDigest!: () => void
      const digestPending = new Promise<void>((resolve) => {
        releaseDigest = resolve
      })
      let finalDigestStarted!: () => void
      const finalDigest = new Promise<void>((resolve) => {
        finalDigestStarted = resolve
      })
      const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
      let digestCalls = 0
      vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
        digestCalls += 1
        if (digestCalls === 5) {
          finalDigestStarted()
          await digestPending
        }
        return digest(algorithm, data)
      })
      const adapter = createDocsEditorAdapter({
        context: () => ctx,
        document: () => state,
        consumeApproval: () => true,
      })
      const plan = await adapter.propose(editRequest())

      const resultPending = adapter.apply({ ...plan, approvalId: 'approval-1' })
      await finalDigest
      mutate(state)
      releaseDigest()
      const result = await resultPending

      expect(result).toMatchObject({
        ok: false,
        warnings: [expect.objectContaining({ code })],
      })
      expect(ctx.editor?.state.doc.textContent).toBe('Original text.')
    },
  )

  it.each([
    {
      failure: 'a detached browser',
      mutate: (state: ReturnType<typeof liveDocumentState>) => {
        state.attached = false
      },
    },
    {
      failure: 'a different document',
      mutate: (state: ReturnType<typeof liveDocumentState>) => {
        state.documentId = 'document-2' as DocumentId
      },
    },
    {
      failure: 'a different client',
      mutate: (state: ReturnType<typeof liveDocumentState>) => {
        state.clientId = 'client-2' as ClientId
      },
    },
    {
      failure: 'a stale disk revision',
      mutate: (state: ReturnType<typeof liveDocumentState>) => {
        state.revision = 2 as Revision
      },
    },
  ])('discards a proposal after $failure', async ({ mutate }) => {
    const ctx = createContext()
    const state = liveDocumentState()
    const approvals = new Map<string, string>()
    const adapter = createDocsEditorAdapter({
      context: () => ctx,
      document: () => state,
      consumeApproval(id, hash) {
        if (approvals.get(id) !== hash) return false
        approvals.delete(id)
        return true
      },
    })
    const plan = await adapter.propose(editRequest())
    approvals.set('approval-1', plan.planHash)

    mutate(state)
    const failed = await adapter.apply({ ...plan, approvalId: 'approval-1' })
    Object.assign(state, liveDocumentState())
    const retried = await adapter.apply({ ...plan, approvalId: 'approval-1' })

    expect(failed.ok).toBe(false)
    expect(retried).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'APPROVAL_INVALID' })],
    })
    expect(ctx.editor?.state.doc.textContent).toBe('Original text.')
  })

  it('discards a proposal after its exact approval is rejected', async () => {
    const { adapter, approvals, ctx } = setup()
    const plan = await adapter.propose(editRequest())

    const rejected = await adapter.apply({ ...plan, approvalId: 'approval-1' })
    approvals.set('approval-1', plan.planHash)
    const retried = await adapter.apply({ ...plan, approvalId: 'approval-1' })

    expect(rejected).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'APPROVAL_INVALID' })],
    })
    expect(retried).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'APPROVAL_INVALID' })],
    })
    expect(ctx.editor?.state.doc.textContent).toBe('Original text.')
  })

  it('bounds pending proposals while retaining the newest plan', async () => {
    const { adapter, approvals, ctx } = setup()
    const plans = []
    for (let index = 0; index < 129; index += 1) {
      plans.push(
        await adapter.propose(
          editRequest({ operationId: `operation-${String(index)}` as OperationId }),
        ),
      )
    }
    const oldest = plans[0]!
    const newest = plans.at(-1)!
    approvals.set('oldest-approval', oldest.planHash)
    approvals.set('newest-approval', newest.planHash)

    const evicted = await adapter.apply({ ...oldest, approvalId: 'oldest-approval' })
    const retained = await adapter.apply({ ...newest, approvalId: 'newest-approval' })

    expect(evicted).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'APPROVAL_INVALID' })],
    })
    expect(retained.ok).toBe(true)
    expect(ctx.editor?.state.doc.textContent).toBe('Approved text.')
  })

  it('replaces a pending proposal without letting the old plan delete the new one', async () => {
    const { adapter, approvals, ctx } = setup()
    const oldPlan = await adapter.propose(editRequest())
    const editor = ctx.editor!
    editor.view.dispatch(editor.state.tr.insertText(' Typed.', editor.state.doc.content.size - 1))
    const newPlan = await adapter.propose(editRequest())
    approvals.set('old-approval', oldPlan.planHash)

    const oldResult = await adapter.apply({ ...oldPlan, approvalId: 'old-approval' })
    approvals.set('new-approval', newPlan.planHash)
    const newResult = await adapter.apply({ ...newPlan, approvalId: 'new-approval' })

    expect(oldResult).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'APPROVAL_INVALID' })],
    })
    expect(newResult.ok).toBe(true)
    expect(editor.state.doc.textContent).toBe('Approved text. Typed.')
  })

  it('does not claim success when an approved operation changes nothing', async () => {
    const { adapter, approvals } = setup()
    const plan = await adapter.propose(
      editRequest({
        arguments: { ops: [{ op: 'findReplace', find: 'Missing', replace: 'Approved' }] },
      }),
    )
    approvals.set('approval-1', plan.planHash)

    const result = await adapter.apply({ ...plan, approvalId: 'approval-1' })

    expect(result).toMatchObject({
      ok: false,
      verification: {
        passed: false,
        issues: [expect.objectContaining({ code: 'NO_CHANGES' })],
      },
    })
  })

  it('bounds operation, target, and serialized payload counts before approval', async () => {
    const { adapter } = setup()
    const operations = Array.from({ length: 201 }, (_, index) => ({
      op: 'findReplace',
      find: `a-${index}`,
      replace: `b-${index}`,
    }))

    await expect(adapter.propose(editRequest({ arguments: { ops: operations } }))).rejects.toThrow(
      /200 operations/i,
    )
    await expect(
      adapter.propose(
        editRequest({
          arguments: {
            ops: [
              {
                op: 'setFont',
                target: { blockIndexes: Array.from({ length: 201 }, (_, index) => index) },
                bold: true,
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/200 targets/i)
    await expect(
      adapter.propose(
        editRequest({
          arguments: {
            ops: [{ op: 'findReplace', find: 'Original', replace: 'x'.repeat(256 * 1024) }],
          },
        }),
      ),
    ).rejects.toThrow(/256 KiB/i)
  })

  it('returns a bounded Agent-facing read result', async () => {
    const { adapter } = setup()

    const result = await adapter.read({
      documentId,
      command: 'read_document',
      arguments: {},
    })

    expect(result).toMatchObject({ ok: true, data: { blocks: expect.any(Array) } })
    expect(() => parseAgentToolResult(result)).not.toThrow()
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      256 * 1024,
    )
  })
})
