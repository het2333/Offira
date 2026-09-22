// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { RibbonHomeTab } from '../src/renderer/components/RibbonHomeTab'
import type { RibbonTabCtx } from '../src/renderer/components/ribbon-shared'

test.each([true, false])('Slides ribbon uses the correct AI identity for Web=%s and keeps toggle behavior', async (web) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('slidesApi', { onFontsChanged: () => () => {} })
  if (web) Object.assign(window, { nexusdeskSlidesHost: {} })
  else delete (window as Window & { nexusdeskSlidesHost?: unknown }).nexusdeskSlidesHost
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onToggleAi = vi.fn()
  const rb = new Proxy({
    aiOpen: false,
    deckEmpty: true,
    hasDoc: false,
    layouts: [],
    layoutSize: { w: 960, h: 540 },
    fmtBtn: () => null,
    onToggleAi,
    t: (key: string) => key,
  }, { get: (target, key) => Reflect.get(target, key) ?? (String(key).startsWith('on') || String(key).startsWith('set') ? () => {} : false) }) as unknown as RibbonTabCtx
  try {
    await act(async () => root.render(createElement(RibbonHomeTab, { rb })))
    const button = container.querySelector<HTMLButtonElement>('.rb-big.ai-entry')!
    expect(button).not.toBeNull()
    expect(button.textContent).toBe(web ? 'Offira AI' : 'Genspark AI')
    expect(button.querySelector('img') instanceof HTMLImageElement).toBe(web)
    await act(async () => button.click())
    expect(onToggleAi).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    delete (window as Window & { nexusdeskSlidesHost?: unknown }).nexusdeskSlidesHost
    container.remove()
    vi.unstubAllGlobals()
  }
})
