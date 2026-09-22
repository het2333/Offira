// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { showApprovalDialog } from '../src/approval-dialog'

beforeEach(() => { const slot = document.createElement('div'); slot.dataset.agentApprovalSlot = ''; document.body.append(slot) })
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers() })
describe('in-page approval', () => {
  it('shows readable changes and collapses technical details', () => {
    showApprovalDialog('apply_document_operations hash:123', vi.fn(), {
      title: '确认以下修改？', summary: '请核对修改内容，确认后才会执行。', items: ['第 3 个内容块\n「7月」 → 「8月」'],
    })
    expect(document.querySelector('h2')?.textContent).toBe('确认以下修改？')
    expect(document.querySelector('details')?.open).toBe(false)
    expect(document.querySelector('pre')?.textContent).toContain('hash:123')
    expect(document.querySelector('section')?.textContent).toContain('「7月」 → 「8月」')
  })
  it('waits for explicit approval and sends the answer only once', () => {
    const answer = vi.fn()
    showApprovalDialog('只替换指定词语 <script>bad()</script>', answer)
    expect(answer).not.toHaveBeenCalled()
    expect(document.querySelector('[data-agent-approval-slot] [role="group"]')).not.toBeNull()
    expect(document.querySelector('[aria-modal]')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    const approve = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '批准本次操作')!
    approve.click(); approve.click()
    expect(answer.mock.calls).toEqual([[true]])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('does not steal focus and rejects on Escape within the card', () => {
    const input = document.createElement('input'); document.body.append(input); input.focus()
    const answer = vi.fn()
    showApprovalDialog('修改日期', answer)
    expect(document.activeElement).toBe(input)
    document.querySelector('[role="group"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(answer.mock.calls).toEqual([[false]])
    expect(document.activeElement).toBe(input)
  })
  it('expires without allowing a stale button to approve', () => {
    vi.useFakeTimers()
    const answer = vi.fn()
    const cancel = showApprovalDialog('保存文档', answer)
    const button = document.querySelectorAll('button')[1]!
    vi.advanceTimersByTime(110_000)
    expect(button.parentElement?.style.display).toBe('none')
    expect(document.body.textContent).toContain('确认已过期')
    button.click(); cancel()
    expect(answer.mock.calls).toEqual([[false]])
  })
})
