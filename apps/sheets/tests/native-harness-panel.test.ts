// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { NativeHarnessPanel } from '../src/renderer/native-harness'

const { mount } = vi.hoisted(() => ({ mount: vi.fn(async (_options: { signal: AbortSignal }) => () => {}) }))
vi.mock('@nexusdesk/web-client/harness-inline-panel', () => ({ mountInlineOfficePanel: mount }))

test('Sheets panel shows registration progress and can retry an initial mount failure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mount.mockReset().mockRejectedValueOnce(new Error('启动失败')).mockResolvedValue(() => {})
  let attached = false
  const frames = new Set<(frame: any) => void>()
  const client = { state: 'ready', onState: () => () => {}, onFrame: (fn: any) => { frames.add(fn); return () => frames.delete(fn) } }
  vi.stubGlobal('nexusdeskBrowserHost', {
    document: { documentId: 'sheet-a' },
    bridge: { transportClient: () => client, client: () => ({ clientId: 'client-a', attached }) },
  })
  const props = { isOpen: true, onExpand() {}, onCollapse() {}, captureSnapshot: () => ({ revision: 1 as any, selection: null }) }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(NativeHarnessPanel, props)))
    expect(container.textContent).toContain('正在连接当前文档')
    attached = true
    await act(async () => { for (const fn of frames) fn({ type: 'editor:registered', documentId: 'sheet-a' }) })
    expect(mount).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('启动失败')
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '重试连接')
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    expect(mount).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('启动失败')
    await act(async () => root.unmount())
  } finally { container.remove(); vi.unstubAllGlobals() }
})
