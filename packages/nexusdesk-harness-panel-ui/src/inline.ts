import { installOfficePanelBinding, type OfficePanelBinding } from './binding'

export interface InlineHarnessOptions {
  container: HTMLElement
  signal: AbortSignal
  onFailure(error: unknown): void
  bootstrapUrl: string
  binding: OfficePanelBinding
  rpc: object
  fetch?: typeof fetch
}
export interface InlineHarnessHandle { dispose(): Promise<void> }

let active: InlineHarnessHandle | undefined

/** Mount the official application into the editor-owned sidebar, never a document root. */
export async function mountInlineHarness(options: InlineHarnessOptions): Promise<InlineHarnessHandle> {
  options.signal.throwIfAborted()
  if (active) throw new Error('当前页面已有文档助手。')
  let entry: { run(onFailure: (error: unknown) => void): Promise<void>; dispose(): Promise<void> } | undefined
  let clearBinding: (() => void) | undefined
  let clearSurface: (() => void) | undefined
  const scripts: HTMLScriptElement[] = []
  const target = globalThis as typeof globalThis & { __DSH_TRANSPORT__?: unknown }
  const previousTransport = target.__DSH_TRANSPORT__
  let running: Promise<void> | undefined
  let disposal: Promise<void> | undefined
  const handle: InlineHarnessHandle = {
    dispose() {
      return disposal ??= (async () => {
      options.signal.removeEventListener('abort', abort)
      // Official run creates its Context asynchronously and has no cancellation API.
      // Retain page ownership until its eventual Context can actually be disposed.
      await running?.catch(() => undefined)
      try {
      await entry?.dispose()
      } finally {
      clearBinding?.()
      clearSurface?.()
      for (const script of scripts) script.remove()
      target.__DSH_TRANSPORT__ = previousTransport
      if (active === handle) active = undefined
      }
      })()
    },
  }
  const abort = () => { void handle.dispose() }
  active = handle
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    const response = await (options.fetch ?? fetch)(options.bootstrapUrl, { credentials: 'same-origin', signal: options.signal })
    if (!response.ok) throw new Error(`文档助手启动失败（${response.status}）。`)
    const rows = await response.json()
    options.signal.throwIfAborted()
    const { AppWebEntry, applyIndexInjections } = await import('@deepseek-ai/dsh-client-web')
    options.signal.throwIfAborted()
    target.__DSH_TRANSPORT__ = { rpc: options.rpc }
    clearBinding = installOfficePanelBinding(options.binding)
    await applyIndexInjections(rows, (src) => new Promise<void>((resolve, reject) => {
      const url = new URL(src, location.href)
      if (url.origin !== location.origin || !(url.pathname.startsWith('/plugins/') || url.pathname === '/harness/loader.js')) {
        reject(new Error('无效的官方模块地址。')); return
      }
      const script = document.createElement('script')
      const cleanup = () => {
        options.signal.removeEventListener('abort', cancelled)
        script.onload = null
        script.onerror = null
      }
      const cancelled = () => { cleanup(); script.remove(); reject(options.signal.reason) }
      scripts.push(script)
      script.src = url.href
      script.onload = () => { cleanup(); resolve() }
      script.onerror = () => { cleanup(); reject(new Error('官方聊天模块加载失败。')) }
      options.signal.addEventListener('abort', cancelled, { once: true })
      if (options.signal.aborted) { cancelled(); return }
      document.head.append(script)
    }))
    options.signal.throwIfAborted()
    const uiRoot = document.createElement('div')
    uiRoot.style.cssText = 'height:100%;min-height:0;display:flex;flex-direction:column'
    const portalRoot = document.createElement('div')
    portalRoot.dataset.nexusdeskOfficePortal = ''
    portalRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1000'
    const portalStyle = document.createElement('style')
    portalStyle.textContent = '[data-nexusdesk-office-portal]>*{pointer-events:auto}[data-nexusdesk-office-portal]>[role=presentation]{position:absolute!important;left:var(--office-left)!important;top:var(--office-top)!important;right:auto!important;bottom:auto!important;width:var(--office-width)!important;height:var(--office-height)!important}[data-nexusdesk-office-portal] [role=dialog]{max-width:calc(var(--office-width) - 16px);max-height:calc(var(--office-height) - 16px)}'
    const updateBounds = () => {
      const rect = options.container.getBoundingClientRect()
      for (const [key, value] of Object.entries({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })) portalRoot.style.setProperty(`--office-${key}`, `${value}px`)
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateBounds)
    resize?.observe(options.container)
    window.addEventListener('resize', updateBounds)
    window.addEventListener('scroll', updateBounds, true)
    options.container.dataset.nexusdeskThemeRoot = ''
    options.container.append(uiRoot, portalRoot, portalStyle)
    updateBounds()
    clearSurface = () => {
      resize?.disconnect()
      window.removeEventListener('resize', updateBounds)
      window.removeEventListener('scroll', updateBounds, true)
      delete options.container.dataset.nexusdeskThemeRoot
      uiRoot.remove(); portalRoot.remove(); portalStyle.remove()
    }
    entry = new AppWebEntry(uiRoot)
    let failure: unknown
    running = entry.run((error) => { failure = error; options.onFailure(error) })
    await running
    options.signal.throwIfAborted()
    if (failure) throw failure
    return handle
  } catch (error) {
    await handle.dispose()
    throw error
  }
}
