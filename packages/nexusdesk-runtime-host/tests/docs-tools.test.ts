import { describe, expect, it, vi } from 'vitest'

import type { AgentToolResult } from '@nexusdesk/protocol'
import { createDocsTools } from '../src/docs-tools'

const success: AgentToolResult = {
  ok: true,
  summary: 'Applied one document operation.',
  changes: { targets: ['text:Original'], count: 1 },
  warnings: [],
  verification: { passed: true, issues: [] },
}

function execution() {
  return { signal: new AbortController().signal } as never
}

describe('official Harness Docs tools', () => {
  it('registers the curated document capabilities instead of editor engine methods', () => {
    const tools = createDocsTools({
      request: vi.fn().mockResolvedValue(success),
      approve: vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' }),
    })

    expect(tools.map((tool) => tool.name)).toEqual([
      'read_document',
      'apply_document_operations',
      'save_document',
    ])
    expect(tools.some((tool) => /tiptap|prosemirror|docx-engine/i.test(tool.name))).toBe(false)
  })

  it('proposes, requests exact approval, and applies one Docs DSL batch', async () => {
    const operations = [{ op: 'findReplace', find: 'Original', replace: 'Approved' }]
    const proposal = {
      ok: true,
      summary: 'Apply one document operation.',
      warnings: [],
      data: {
        operationId: 'operation-1',
        planHash: 'plan-hash-1',
        summary: 'Apply one document operation.',
        targets: ['text:Original'],
      },
    }
    const request = vi.fn().mockResolvedValueOnce(proposal).mockResolvedValueOnce(success)
    const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' })
    const apply = createDocsTools({ request, approve })[1]!

    const result = await apply.execute({ operations }, execution())

    expect(request).toHaveBeenNthCalledWith(
      1,
      'propose_ops',
      { ops: operations },
      expect.anything(),
    )
    expect(approve).toHaveBeenCalledWith(
      'apply_document_operations',
      {
        operationId: 'operation-1',
        planHash: 'plan-hash-1',
        summary: 'Apply one document operation.',
        targets: ['text:Original'],
        warnings: [],
      },
      expect.anything(),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'apply_ops',
      { ops: operations },
      expect.anything(),
      { approvalId: 'approval-1', planHash: 'plan-hash-1', operationId: 'operation-1' },
    )
    expect(result).toEqual(success)
  })

  it('projects reads to AgentToolResult fields only', async () => {
    const unsafe = {
      ...success,
      data: { blocks: [{ index: 0, type: 'p', text: 'Hello' }] },
      editor: { unsafe: true },
      engine: { unsafe: true },
      webContents: { unsafe: true },
    }
    const read = createDocsTools({
      request: vi.fn().mockResolvedValue(unsafe),
      approve: vi.fn(),
    })[0]!

    const result = await read.execute({ scope: 'document' }, execution())

    expect(result).toMatchObject({ ok: true, summary: success.summary })
    expect(result).not.toHaveProperty('editor')
    expect(result).not.toHaveProperty('engine')
    expect(result).not.toHaveProperty('webContents')
  })

  it('fails closed for malformed proposals and denied approvals', async () => {
    const malformedRequest = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'bad proposal',
      warnings: [],
      data: { operationId: 'operation-1' },
    })
    const malformed = createDocsTools({
      request: malformedRequest,
      approve: vi.fn(),
    })[1]!
    await expect(malformed.execute({ operations: [{}] }, execution())).rejects.toThrow(
      /invalid edit proposal/i,
    )

    const deniedRequest = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'proposal',
      warnings: [],
      data: { operationId: 'operation-1', planHash: 'plan-hash-1', targets: [] },
    })
    const denied = createDocsTools({
      request: deniedRequest,
      approve: vi.fn().mockResolvedValue({ approved: false }),
    })[1]!
    await expect(denied.execute({ operations: [{}] }, execution())).resolves.toMatchObject({
      ok: false,
      warnings: [{ code: 'APPROVAL_DENIED' }],
    })
    expect(deniedRequest).toHaveBeenCalledTimes(1)
  })
})
