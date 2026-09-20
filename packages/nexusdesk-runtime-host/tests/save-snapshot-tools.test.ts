import { expect, it, vi } from 'vitest'
import { createDocsTools } from '../src/docs-tools'
import { createSheetsTools } from '../src/sheets-tools'
import { createMarkdownTools } from '../src/markdown-tools'
import { createHtmlTools } from '../src/html-tools'

it.each([
  [createDocsTools, 'save_document'],
  [createSheetsTools, 'save_sheet'],
  [createMarkdownTools, 'save_markdown'],
  [createHtmlTools, 'save_html'],
] as const)('%s binds save to a proposed snapshot and operation', async (create, command) => {
  const saved = { ok: true, summary: 'saved', warnings: [] }
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      summary: 'Save exact snapshot',
      warnings: [],
      data: {
        operationId: 'save-1',
        planHash: 'hash-1',
        snapshotHash: 'snapshot-1',
        targets: ['current file'],
      },
    })
    .mockResolvedValueOnce(saved)
  const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' })
  const tool = create({ request, approve }).find((tool) => tool.name === command)!
  expect(await tool.execute({}, { signal: new AbortController().signal } as never)).toEqual(saved)
  expect(request).toHaveBeenNthCalledWith(1, 'propose_save', {}, expect.anything())
  expect(approve).toHaveBeenCalledWith(
    command,
    expect.objectContaining({
      operationId: 'save-1',
      planHash: 'hash-1',
      targets: ['current file'],
    }),
    expect.anything(),
  )
  expect(request).toHaveBeenNthCalledWith(
    2,
    command,
    { inPlace: true, snapshotHash: 'snapshot-1' },
    expect.anything(),
    { approvalId: 'approval-1', planHash: 'hash-1', operationId: 'save-1' },
  )
})
