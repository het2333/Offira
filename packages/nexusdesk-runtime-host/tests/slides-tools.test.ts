import { describe, expect, it, vi } from 'vitest'

import type { AgentToolResult } from '@nexusdesk/protocol'
import { createSlidesTools } from '../src/slides-tools'

const success: AgentToolResult = {
  ok: true,
  summary: 'Applied one presentation operation.',
  changes: { targets: ['slide:1/title'], count: 1 },
  warnings: [],
  verification: { passed: true, issues: [] },
}

describe('official Harness Slides tools', () => {
  it('registers curated presentation tools rather than Electron or engine methods', () => {
    const tools = createSlidesTools({
      request: vi.fn().mockResolvedValue(success),
      approve: vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' }),
    })

    expect(tools.map((tool) => tool.name)).toEqual([
      'read_presentation',
      'apply_presentation_operations',
      'save_presentation',
    ])
    expect(tools.some((tool) => /electron|webcontents|pptx-engine/i.test(tool.name))).toBe(false)
  })

  it('binds approval to the exact presentation transaction and projects only AgentToolResult', async () => {
    const proposal: AgentToolResult = {
      ok: true,
      summary: 'Add a title.',
      warnings: [],
      data: {
        operationId: 'operation-1',
        planHash: 'plan-hash-1',
        summary: 'Add a title.',
        targets: ['slide:1'],
      },
    }
    const request = vi.fn().mockResolvedValueOnce(proposal).mockResolvedValueOnce(success)
    const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' })
    const apply = createSlidesTools({ request, approve })[1]!
    const operations = [{ op: 'setText', target: { slide: 0, el: 'title' }, paragraphs: [] }]

    const result = await apply.execute({ operations }, { signal: new AbortController().signal } as never)

    expect(approve).toHaveBeenCalledWith(
      'apply_presentation_operations',
      expect.objectContaining({ planHash: 'plan-hash-1', targets: ['slide:1'] }),
      expect.anything(),
    )
    expect(request).toHaveBeenLastCalledWith(
      'apply_ops',
      { ops: operations },
      expect.anything(),
      { approvalId: 'approval-1', planHash: 'plan-hash-1', operationId: 'operation-1' },
    )
    expect(JSON.stringify(result)).not.toMatch(/engine|electron|webcontents/i)
  })
})
