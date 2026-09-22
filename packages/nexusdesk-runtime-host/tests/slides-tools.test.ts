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
  it.each(['apply_presentation_operations', 'save_presentation', 'undo_presentation', 'redo_presentation'])('%s returns a readable denial without sending a mutation', async (name) => {
    const request = vi.fn().mockResolvedValue({ ok: true, summary: '提案', warnings: [], data: {
      operationId: 'operation-1', planHash: 'plan-hash-1', summary: '提案', targets: ['第 1 页'], contentVersion: 1,
    } })
    const approve = vi.fn().mockResolvedValue({ approved: false })
    const tool = createSlidesTools({ request, approve }).find(item => item.name === name)!

    const response = await tool.execute(name === 'apply_presentation_operations' ? { operations: [{ op: 'setText' }] } : {}, { signal: new AbortController().signal } as never)

    expect(response).toMatchObject({ ok: false, summary: '未获批准，演示文稿未修改。', warnings: [{ code: 'APPROVAL_DENIED' }] })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('registers curated presentation tools rather than Electron or engine methods', () => {
    const tools = createSlidesTools({
      request: vi.fn().mockResolvedValue(success),
      approve: vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' }),
    })

    expect(tools.map((tool) => tool.name)).toEqual([
      'read_presentation',
      'apply_presentation_operations',
      'save_presentation',
      'undo_presentation',
      'redo_presentation',
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
      expect.objectContaining({ operationId: 'operation-1', planHash: 'plan-hash-1', targets: ['slide:1'] }),
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

  it('binds an in-place save to its current presentation version before asking for approval', async () => {
    const saveProposal: AgentToolResult = {
      ok: true,
      summary: 'Save the current presentation in place.',
      warnings: [],
      data: {
        operationId: 'save-operation-1',
        planHash: 'save-plan-hash-1',
        summary: 'Save the current presentation in place.',
        targets: ['current presentation'],
        contentVersion: 2,
      },
    }
    const request = vi.fn().mockResolvedValueOnce(saveProposal).mockResolvedValueOnce(success)
    const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' })
    const save = createSlidesTools({ request, approve })[2]!

    await expect(save.execute({}, { signal: new AbortController().signal } as never)).resolves.toEqual(success)

    expect(request).toHaveBeenNthCalledWith(1, 'propose_save', {}, expect.anything())
    expect(approve).toHaveBeenCalledWith(
      'save_presentation',
      expect.objectContaining({ operationId: 'save-operation-1', planHash: 'save-plan-hash-1' }),
      expect.anything(),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'save_presentation',
      { inPlace: true, contentVersion: 2 },
      expect.anything(),
      { approvalId: 'approval-1', planHash: 'save-plan-hash-1', operationId: 'save-operation-1' },
    )
  })

  it.each([
    ['undo_presentation', 'undo'],
    ['redo_presentation', 'redo'],
  ] as const)('proposes, approves, and applies %s as a typed history transaction', async (toolName, action) => {
    const historyProposal: AgentToolResult = {
      ok: true,
      summary: `${toolName} the latest presentation change.`,
      warnings: [],
      data: {
        operationId: `${action}-operation-1`,
        planHash: `${action}-plan-hash-1`,
        summary: `${toolName} the latest presentation change.`,
        targets: ['presentation history'],
      },
    }
    const historyResult: AgentToolResult = {
      ok: true,
      summary: `${toolName} the latest presentation change.`,
      warnings: [],
      changes: { targets: ['presentation history'], count: 1 },
    }
    const request = vi.fn().mockResolvedValueOnce(historyProposal).mockResolvedValueOnce(historyResult)
    const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' })
    const historyTool = createSlidesTools({ request, approve }).find((tool) => tool.name === toolName)!

    await expect(historyTool.execute({}, { signal: new AbortController().signal } as never)).resolves.toEqual(historyResult)

    expect(request).toHaveBeenNthCalledWith(1, 'propose_history', { action }, expect.anything())
    expect(approve).toHaveBeenCalledWith(
      toolName,
      expect.objectContaining({ operationId: `${action}-operation-1`, planHash: `${action}-plan-hash-1` }),
      expect.anything(),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'apply_history',
      { action },
      expect.anything(),
      { approvalId: 'approval-1', planHash: `${action}-plan-hash-1`, operationId: `${action}-operation-1` },
    )
  })
})
