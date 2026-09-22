// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { NativeHarnessPanel } from '../src/renderer/native-harness'

const { mount } = vi.hoisted(() => ({ mount: vi.fn(async (_options: { signal: AbortSignal }) => () => {}) }))
vi.mock('@nexusdesk/web-client/harness-inline-panel', () => ({ mountInlineOfficePanel: mount }))

test('waits for document registration before mounting and binds once on its receipt', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Set<(frame: any) => void>()
  let attached = false
  const states = new Set<(state: string) => void>()
  const client = { state: 'ready', onState: (fn: any) => { states.add(fn); return () => states.delete(fn) }, onFrame: (fn: any) => { frames.add(fn); return () => frames.delete(fn) } }
  Object.assign(window, { nexusdeskBrowserHost: {
    document: { documentId: 'document-1' },
    bridge: { transportClient: () => client, client: () => ({ clientId: 'client-1', attached }) },
  } })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(NativeHarnessPanel, {
      isOpen: true, onExpand() {}, onCollapse() {}, scopeLabel: '已选中 A1:A3', onScopeDismiss() {}, captureSnapshot: () => ({ revision: 1 as any, selection: null }),
    })))
    expect(mount).not.toHaveBeenCalled()
    attached = true
    await act(async () => { for (const fn of frames) fn({ type: 'editor:registered', documentId: 'document-1' }) })
    expect(mount).toHaveBeenCalledTimes(1)
    const mountedOptions = mount.mock.calls[0]![0]
    const chatHost = container.querySelector('.native-harness-panel-host')!
    chatHost.textContent = 'unsent draft'
    await act(async () => root.render(createElement(NativeHarnessPanel, {
      isOpen: false, onExpand() {}, onCollapse() {}, captureSnapshot: () => ({ revision: 1 as any, selection: null }),
    })))
    expect(mountedOptions.signal.aborted).toBe(false)
    expect(container.contains(chatHost)).toBe(true)
    await act(async () => root.render(createElement(NativeHarnessPanel, {
      isOpen: true, onExpand() {}, onCollapse() {}, scopeLabel: '已选中 A1:A3', captureSnapshot: () => ({ revision: 1 as any, selection: null }),
    })))
    expect(chatHost.textContent).toBe('unsent draft')
    expect(mount).toHaveBeenCalledTimes(1)
    await act(async () => { client.state = 'reconnecting'; for (const fn of states) fn('reconnecting') })
    expect(mountedOptions.signal.aborted).toBe(false)
    expect(chatHost.textContent).toBe('unsent draft')
    await act(async () => { client.state = 'ready'; for (const fn of states) fn('ready'); for (const fn of frames) fn({ type: 'editor:registered', documentId: 'document-1' }) })
    expect(mount).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('已选中 A1:A3')
    expect(container.querySelector('button[aria-label="取消选区引用"]')).not.toBeNull()
    await act(async () => { for (const fn of frames) fn({ type: 'editor:registered', documentId: 'document-1' }) })
    expect(mount).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    Reflect.deleteProperty(window, 'nexusdeskBrowserHost')
    vi.unstubAllGlobals()
  }
})
