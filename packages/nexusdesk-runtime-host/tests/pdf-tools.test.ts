import { describe, expect, it, vi } from 'vitest'

import type { AgentToolResult } from '@nexusdesk/protocol'
import { createPdfTools } from '../src/pdf-tools'

const success: AgentToolResult = {
  ok: true,
  summary: 'Applied one PDF operation.',
  changes: { targets: ['page:1'], count: 1 },
  warnings: [],
  verification: { passed: true, issues: [] },
}

function execution() {
  return { signal: new AbortController().signal } as never
}

describe('official Harness PDF tools', () => {
  it('registers curated PDF capabilities instead of renderer or PDFium methods', () => {
    const tools = createPdfTools({
      request: vi.fn().mockResolvedValue(success),
      approve: vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' }),
    })

    expect(tools.map((tool) => tool.name)).toEqual([
      'read_pdf',
      'apply_pdf_operations',
      'save_pdf',
    ])
    expect(tools.some((tool) => /pdfium|electron|renderer|engine/i.test(tool.name))).toBe(false)
  })

  it('binds one approved PDF DSL batch to its exact proposal', async () => {
    const operations = [{ op: 'rotatePages', pages: [1], dir: 90 }]
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        summary: 'Rotate page 1.',
        warnings: [],
        data: {
          operationId: 'operation-1',
          planHash: 'plan-hash-1',
          summary: 'Rotate page 1.',
          targets: ['page:1'],
        },
      })
      .mockResolvedValueOnce(success)
    const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' })
    const apply = createPdfTools({ request, approve })[1]!

    await expect(apply.execute({ operations }, execution())).resolves.toEqual(success)
    expect(request).toHaveBeenNthCalledWith(1, 'propose_ops', { ops: operations }, expect.anything())
    expect(approve).toHaveBeenCalledWith(
      'apply_pdf_operations',
      { planHash: 'plan-hash-1', summary: 'Rotate page 1.', targets: ['page:1'], warnings: [] },
      expect.anything(),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'apply_ops',
      { ops: operations },
      expect.anything(),
      { approvalId: 'approval-1', planHash: 'plan-hash-1', operationId: 'operation-1' },
    )
  })

  it('projects reads to the AgentToolResult envelope only', async () => {
    const read = createPdfTools({
      request: vi.fn().mockResolvedValue({
        ...success,
        data: { pages: [{ page: 1, text: 'safe' }] },
        pdfium: { private: true },
        electron: { private: true },
        editor: { private: true },
      }),
      approve: vi.fn(),
    })[0]!

    const result = await read.execute({ start: 1, end: 1 }, execution())
    expect(result).toMatchObject({ ok: true, summary: success.summary })
    expect(result).not.toHaveProperty('pdfium')
    expect(result).not.toHaveProperty('electron')
    expect(result).not.toHaveProperty('editor')
  })
})
