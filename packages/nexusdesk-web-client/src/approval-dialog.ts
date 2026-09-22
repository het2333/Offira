/** An explicit in-page decision; browser modal suppression must never decide approval. */
export function showApprovalDialog(message: string, answer: (allowed: boolean) => void,
  presentation?: { title: string; summary: string; items: string[] }): () => void {
  const slot = document.querySelector<HTMLElement>('[data-agent-approval-slot]')
  if (!slot) { answer(false); return () => {} }
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'group')
  overlay.setAttribute('aria-label', '操作确认')
  overlay.style.cssText = 'margin:12px 0;max-width:100%;'
  const panel = document.createElement('section')
  panel.style.cssText = 'box-sizing:border-box;width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:14px;font:13px/1.6 system-ui;background:var(--bg-primary,#fff);color:var(--text-primary,#18212f);'
  const title = document.createElement('h2')
  title.textContent = presentation?.title ?? '确认本次操作'
  title.style.cssText = 'font-size:14px;margin:0 0 8px;'
  const detail = document.createElement('div')
  detail.textContent = presentation
    ? [presentation.summary, ...presentation.items.map((item, i) => `${i + 1}. ${item}`)].join('\n\n')
    : message
  detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;'
  const hint = document.createElement('p')
  hint.textContent = '选择后继续，无需另发确认消息。'
  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;margin-top:20px;'
  const reject = document.createElement('button')
  const approve = document.createElement('button')
  reject.textContent = '拒绝'
  approve.textContent = '批准本次操作'
  for (const button of [reject, approve]) {
    button.type = 'button'
    button.style.cssText = 'cursor:pointer;border:1px solid #cbd5e1;border-radius:7px;padding:9px 16px;font:inherit;background:#fff;color:#18212f;'
  }
  approve.style.background = '#225ad5'
  approve.style.color = '#fff'
  let settled = false
  const finish = (allowed: boolean, reason = '已拒绝，本次操作不会执行。') => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    reject.disabled = true
    approve.disabled = true
    actions.hidden = true
    actions.style.display = 'none'
    hint.textContent = allowed ? '已批准，等待执行结果。' : reason
    answer(allowed)
  }
  const timer = setTimeout(() => finish(false, '确认已过期，本次操作不会执行。需要时请重新发起。'), 110_000)
  reject.onclick = () => finish(false)
  approve.onclick = () => finish(true)
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); finish(false) }
  })
  actions.append(reject, approve)
  panel.append(title, detail)
  if (presentation) {
    const technical = document.createElement('details')
    const label = document.createElement('summary')
    label.textContent = '技术详情'
    const raw = document.createElement('pre')
    raw.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;'
    raw.textContent = message
    technical.append(label, raw)
    panel.append(technical)
  }
  panel.append(hint, actions)
  overlay.append(panel)
  slot.append(overlay)
  overlay.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  return () => finish(false)
}
