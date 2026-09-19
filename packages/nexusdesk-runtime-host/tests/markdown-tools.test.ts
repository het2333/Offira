import { describe, expect, it, vi } from 'vitest'

import type { AgentToolResult } from '@nexusdesk/protocol'
import { createMarkdownTools } from '../src/markdown-tools'

const success: AgentToolResult = {
  ok: true,
  summary: 'Applied one Markdown operation.',
  warnings: [],
  verification: { passed: true, issues: [] },
}

function execution() {
  return { signal: new AbortController().signal } as never
}

describe('official Harness Markdown tools', () => {
  it('exposes a curated Markdown tool catalog rather than renderer objects', () => {
    const tools = createMarkdownTools({
      request: vi.fn().mockResolvedValue(success),
      approve: vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' }),
    })
    expect(tools.map((tool) => tool.name)).toEqual([
      'read_markdown',
      'apply_markdown_operations',
      'save_markdown',
    ])
    expect(JSON.stringify(tools)).not.toMatch(/tiptap|prosemirror|electron/i)
    const applySchema = JSON.stringify(tools[1])
    for (const operation of [
      'insertContent',
      'replaceBlocks',
      'deleteBlocks',
      'replaceText',
      'setStyle',
      'setLink',
      'setBlockType',
      'toggleList',
      'moveBlocks',
      'duplicateBlocks',
      'insertTable',
      'insertHorizontalRule',
      'insertImage',
      'editTable',
      'setFrontmatter',
    ]) expect(applySchema).toContain(operation)
  })

  it('binds one Markdown operation batch to the exact approved proposal', async () => {
    const operations = [{ op: 'replaceText', find: 'Initial', replace: 'Approved' }]
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        summary: 'Apply one Markdown operation.',
        warnings: [],
        data: { operationId: 'operation-1', planHash: 'plan-1', targets: ['block:0'] },
      })
      .mockResolvedValueOnce(success)
    const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' })
    const apply = createMarkdownTools({ request, approve })[1]!

    await expect(apply.execute({ operations }, execution())).resolves.toEqual(success)
    expect(request).toHaveBeenNthCalledWith(1, 'propose_ops', { ops: operations }, expect.anything())
    expect(approve).toHaveBeenCalledWith(
      'apply_markdown_operations',
      expect.objectContaining({
        operationId: 'operation-1',
        planHash: 'plan-1',
        targets: ['block:0'],
      }),
      expect.anything(),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'apply_ops',
      { ops: operations },
      expect.anything(),
      { approvalId: 'approval-1', planHash: 'plan-1', operationId: 'operation-1' },
    )
  })
})
