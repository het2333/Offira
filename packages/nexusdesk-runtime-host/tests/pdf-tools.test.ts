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
      'markup_pdf_text',
      'read_pdf_annotations',
      'edit_pdf_text',
      'insert_pdf_text',
      'add_pdf_note',
      'list_pdf_page_images',
      'insert_pdf_image',
      'transform_pdf_image',
      'fill_pdf_form',
      'rotate_pdf_pages',
      'delete_pdf_page',
      'reorder_pdf_pages',
      'set_pdf_metadata',
      'redact_pdf',
      'save_pdf',
    ])
    expect(tools.some((tool) => /pdfium|electron|renderer|engine/i.test(tool.name))).toBe(false)
  })

  it('binds one approved semantic PDF markup to its exact renderer proposal', async () => {
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
    const markup = createPdfTools({ request, approve })[1]!

    await expect(
      markup.execute({ page: 1, text: 'NexusDesk', type: 'highlight' }, execution()),
    ).resolves.toEqual(success)
    expect(request).toHaveBeenNthCalledWith(
      1,
      'propose_ops',
      {
        ops: [{ op: 'markup_pdf_text', page: 1, text: 'NexusDesk', type: 'highlight' }],
      },
      expect.anything(),
    )
    expect(approve).toHaveBeenCalledWith(
      'markup_pdf_text',
      {
        operationId: 'operation-1',
        planHash: 'plan-hash-1',
        summary: 'Rotate page 1.',
        targets: ['page:1'],
        warnings: [],
      },
      expect.anything(),
    )
    expect(request).toHaveBeenNthCalledWith(2, 'apply_ops', {}, expect.anything(), {
      approvalId: 'approval-1',
      planHash: 'plan-hash-1',
      operationId: 'operation-1',
    })
  })

  it('proposes the current renderer snapshot before asking approval to save', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        summary: 'Save the current PDF in place.',
        warnings: [],
        data: { operationId: 'save-operation', planHash: 'save-plan', targets: ['current PDF'] },
      })
      .mockResolvedValueOnce(success)
    const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-save' })
    const save = createPdfTools({ request, approve }).at(-1)!

    await expect(save.execute({}, execution())).resolves.toEqual(success)
    expect(request).toHaveBeenNthCalledWith(1, 'propose_save', {}, expect.anything())
    expect(approve).toHaveBeenCalledWith(
      'save_pdf',
      expect.objectContaining({ planHash: 'save-plan', targets: ['current PDF'] }),
      expect.anything(),
    )
    expect(request).toHaveBeenNthCalledWith(2, 'save_pdf', { inPlace: true }, expect.anything(), {
      approvalId: 'approval-save',
      planHash: 'save-plan',
      operationId: 'save-operation',
    })
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
