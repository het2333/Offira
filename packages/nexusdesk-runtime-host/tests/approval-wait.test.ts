import { expect, test, vi } from 'vitest'
import { waitForApproval } from '../src/approval-wait'

test('lets the Host expire approval before fallback and reports no authorization', async () => {
  vi.useFakeTimers()
  try {
    let answer!: (value: boolean) => void
    let settled = false
    const result = waitForApproval(new Promise(resolve => { answer = resolve }), new AbortController().signal)
      .then(value => { settled = true; return value })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(settled).toBe(false)
    answer(false)
    expect(await result).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

test('a lost approval response fails closed without claiming a dispatched write', async () => {
  vi.useFakeTimers()
  try {
    const result = waitForApproval(new Promise<boolean>(() => {}), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(130_000)
    expect(await result).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
