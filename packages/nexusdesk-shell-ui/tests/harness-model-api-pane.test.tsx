/** @vitest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { OfficeHost } from '@nexusdesk/office-host'
import { HarnessModelApiPane } from '../src/HarnessModelApiPane'
import { OfficeHostProvider } from '../src/office-host-context'
import { LocaleProvider } from '../src/locale'
import type { ShellPlatformServices } from '../src/office-host-context'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('saves a DeepSeek key without rendering its value back into settings', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const setModelCredential = vi.fn(async (ref: string, value: string | null) => {
    expect(ref).toBe('DEEPSEEK_API_KEY')
    expect(value).toBe('sk-secret')
    return { ref, configured: true, source: 'stored', writable: true }
  })
  const platform = { home: {
    getModelCredential: async (ref: string) => ({ ref, configured: false, writable: true }),
    setModelCredential,
  } } as unknown as ShellPlatformServices
  const host = { settings: { update: async () => ({}) } } as unknown as OfficeHost
  try {
    await act(async () => {
      root.render(<OfficeHostProvider host={host} platform={platform}>
        <LocaleProvider initial="zh"><HarnessModelApiPane /></LocaleProvider>
      </OfficeHostProvider>)
      await Promise.resolve()
    })
    const input = container.querySelector<HTMLInputElement>('#offira-api-key')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
      await Promise.resolve()
    })
    expect(setModelCredential).toHaveBeenCalledOnce()
    expect(input.value).toBe('')
    expect(container.textContent).toContain('已保存')
    expect(container.textContent).not.toContain('sk-secret')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
