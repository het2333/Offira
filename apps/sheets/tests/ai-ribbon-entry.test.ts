// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { AiRibbonEntry } from '../src/renderer/AiRibbonEntry'

test('Offira ribbon entry opens and closes the existing assistant', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let toggles = 0
  const props = { nativeHarness: true, onToggle: () => { toggles++ }, assistantTitle: '打开 AI 助手' }
  try {
    await act(async () => root.render(createElement(AiRibbonEntry, { ...props, open: false })))
    const button = container.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('打开 Offira 助手')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.textContent).toBe('Offira AI')
    expect(button.querySelector('img')).not.toBeNull()
    await act(async () => button.click())
    expect(toggles).toBe(1)

    await act(async () => root.render(createElement(AiRibbonEntry, { ...props, open: true })))
    expect(button.getAttribute('aria-label')).toBe('收起 Offira 助手')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    await act(async () => button.click())
    expect(toggles).toBe(2)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

test('GenOffice ribbon keeps its original assistant identity', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(AiRibbonEntry, {
      nativeHarness: false,
      open: false,
      onToggle: () => {},
      assistantTitle: '打开 AI 助手',
    })))
    const button = container.querySelector('button')!
    expect(button.textContent).toBe('Genspark AI')
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.querySelector('img')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
