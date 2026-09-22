// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import { mountInlineHarness } from '../src/inline'
const state = vi.hoisted(() => ({ run: undefined as undefined | ((container: HTMLElement) => Promise<void>) }))

vi.mock('@deepseek-ai/dsh-client-web', () => ({
  applyIndexInjections: async (_rows: unknown, load: (src: string) => Promise<void>) => load('/harness/loader.js'),
  AppWebEntry: class {
    constructor(private container: HTMLElement) {}
    async run() { if (state.run) return state.run(this.container); throw new Error('must not mount after abort') }
    async dispose() { this.container.replaceChildren() }
  },
}))

test('abort during official asynchronous startup cleans up the eventual UI before releasing ownership', async () => {
  let finish!: () => void
  let started = false
  state.run = async container => {
    started = true
    await new Promise<void>(resolve => { finish = resolve })
    container.textContent = 'late official UI'
  }
  const container = document.createElement('aside')
  const abort = new AbortController()
  const outcome = mountInlineHarness({ container, signal: abort.signal, onFailure() {},
    bootstrapUrl: '/harness/boot.json', binding: { sessionId: 's1', captureSubmission() {} }, rpc: {},
    fetch: async () => new Response('[]'),
  }).catch(() => undefined)
  await vi.waitFor(() => expect(document.querySelector('script[src$="/harness/loader.js"]')).not.toBeNull())
  document.querySelector('script[src$="/harness/loader.js"]')!.dispatchEvent(new Event('load'))
  await vi.waitFor(() => expect(started).toBe(true))
  expect(container.querySelector('[data-nexusdesk-office-portal]')).not.toBeNull()
  expect(container.hasAttribute('data-nexusdesk-theme-root')).toBe(true)
  abort.abort()
  finish()
  await outcome
  expect(container.textContent).toBe('')
  state.run = undefined
})

test('aborting a pending module script settles the mount and removes the script', async () => {
  const abort = new AbortController()
  const mounted = mountInlineHarness({ container: document.createElement('aside'), signal: abort.signal,
    onFailure() {}, bootstrapUrl: '/harness/boot.json', binding: { sessionId: 's1', captureSubmission() {} }, rpc: {},
    fetch: async () => new Response('[]'),
  })
  const outcome = mounted.then(() => 'mounted', () => 'aborted')
  await vi.waitFor(() => expect(document.querySelector('script[src$="/harness/loader.js"]')).not.toBeNull())
  abort.abort()
  const settled = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('still waiting'), 30))])
  expect(settled).toBe('aborted')
  expect(document.querySelector('script[src$="/harness/loader.js"]')).toBeNull()
})

test('a failed real boot leaves the host editor intact and creates no iframe', async () => {
  document.body.innerHTML = '<main id="root">editor</main><aside id="panel"></aside>'
  const container = document.getElementById('panel')!
  const onFailure = vi.fn()
  const abort = new AbortController()
  await expect(mountInlineHarness({ container, signal: abort.signal, onFailure,
    bootstrapUrl: '/harness/boot.json', binding: { sessionId: 's1', captureSubmission() {} }, rpc: {},
    fetch: async () => new Response('unavailable', { status: 503 }),
  })).rejects.toThrow()
  expect(document.getElementById('root')!.textContent).toBe('editor')
  expect(container.querySelector('iframe')).toBeNull()
})
