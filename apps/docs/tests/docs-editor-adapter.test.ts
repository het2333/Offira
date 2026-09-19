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
  for (const editor of liveEditors.splice(0)) editor.destroy()
})

describe('Docs editor adapter', () => {
  it('proposes a canonical bounded plan without mutating the document', async () => {
    const { adapter, ctx } = setup()
    const before = ctx.editor?.state.doc.textContent

    const plan = await adapter.propose(editRequest())

    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.operations).toEqual([
      { op: 'findReplace', find: 'Original', replace: 'Approved' },
    ])
    expect(plan.summary).toContain('1')
    expect(ctx.editor?.state.doc.textContent).toBe(before)
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

    await expect(
      adapter.propose(editRequest({ arguments: { ops: operations } })),
    ).rejects.toThrow(/200 operations/i)
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
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(256 * 1024)
  })
})
