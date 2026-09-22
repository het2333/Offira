// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { NativeOfficePanel } from '../src/native-office-panel'

const { mount } = vi.hoisted(() => ({ mount: vi.fn(async (_options: { signal: AbortSignal }) => () => {}) }))
vi.mock('../src/harness-inline-panel', () => ({ mountInlineOfficePanel: mount }))

test('shared editor panel waits for its own registration and preserves its mounted session when collapsed', async () => {
  mount.mockReset().mockResolvedValue(() => {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Set<(frame: any) => void>()
  let attached = false
  const client = { state: 'ready', onState: () => () => {}, onFrame: (fn: any) => { frames.add(fn); return () => frames.delete(fn) } }
  const host = { document: { documentId: 'doc-a' }, bridge: { transportClient: () => client, client: () => ({ clientId: 'client-a', attached }) } } as any
  const props = { host, isOpen: true, onExpand() {}, onCollapse() {}, captureSnapshot: () => ({ revision: 1 as any, selection: null }) }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(NativeOfficePanel, props)))
    expect(mount).not.toHaveBeenCalled()
    attached = true
    await act(async () => { for (const fn of frames) fn({ type: 'editor:registered', documentId: 'other' }) })
    expect(mount).not.toHaveBeenCalled()
    await act(async () => { for (const fn of frames) fn({ type: 'editor:registered', documentId: 'doc-a' }) })
    expect(mount).toHaveBeenCalledTimes(1)
    await act(async () => root.render(createElement(NativeOfficePanel, { ...props, isOpen: false })))
    expect(mount.mock.calls[0]![0].signal.aborted).toBe(false)
    await act(async () => root.unmount())
    expect(mount.mock.calls[0]![0].signal.aborted).toBe(true)
  } finally { container.remove(); vi.unstubAllGlobals() }
})

test('shared editor panel explains pending registration and retries a failed initial mount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mount.mockReset().mockRejectedValueOnce(new Error('启动失败')).mockResolvedValue(() => {})
  let attached = false
  const frames = new Set<(frame: any) => void>()
  const client = { state: 'ready', onState: () => () => {}, onFrame: (fn: any) => { frames.add(fn); return () => frames.delete(fn) } }
  const host = { document: { documentId: 'doc-a' }, bridge: { transportClient: () => client, client: () => ({ clientId: 'client-a', attached }) } } as any
  const props = { host, isOpen: true, onExpand() {}, onCollapse() {}, captureSnapshot: () => ({ revision: 1 as any, selection: null }) }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(NativeOfficePanel, props)))
    expect(container.textContent).toContain('正在连接当前文档')
    attached = true
    await act(async () => { for (const fn of frames) fn({ type: 'editor:registered', documentId: 'doc-a' }) })
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
