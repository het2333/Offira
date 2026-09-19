import { describe, expect, it, vi } from 'vitest'
import type { AgentToolResult } from '@nexusdesk/protocol'
import { createHtmlTools } from '../src/html-tools'

const success: AgentToolResult = { ok: true, summary: 'Applied one HTML operation.', warnings: [], verification: { passed: true, issues: [] } }
function execution() { return { signal: new AbortController().signal } as never }

describe('official Harness HTML tools', () => {
  it('registers the curated HTML DSL instead of renderer internals', () => {
    const tools = createHtmlTools({ request: vi.fn().mockResolvedValue(success), approve: vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' }) })
    expect(tools.map((tool) => tool.name)).toEqual(['read_html', 'apply_html_operations', 'save_html'])
    expect(JSON.stringify(tools)).not.toMatch(/codemirror|electron|parse5/i)
  })
  it('binds an HTML operation batch to its exact approved proposal', async () => {
    const operations = [{ op: 'set_text', sid: 1, text: 'Approved' }]
    const request = vi.fn().mockResolvedValueOnce({ ok: true, summary: 'Apply HTML.', warnings: [], data: { operationId: 'operation-1', planHash: 'plan-1', targets: ['sid:1'] } }).mockResolvedValueOnce(success)
    const approve = vi.fn().mockResolvedValue({ approved: true, approvalId: 'approval-1' })
    await expect(createHtmlTools({ request, approve })[1]!.execute({ operations }, execution())).resolves.toEqual(success)
    expect(request).toHaveBeenNthCalledWith(2, 'apply_ops', { ops: operations }, expect.anything(), { approvalId: 'approval-1', planHash: 'plan-1', operationId: 'operation-1' })
  })
})
