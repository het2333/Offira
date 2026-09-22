// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import { mountInlineOfficePanel } from '../src/harness-inline-panel'
vi.mock('@nexusdesk/harness-office-panel-ui/inline', () => ({ mountInlineHarness: () => { throw Error('must not reach UI') } }))

test('aborting while bind waits releases transport subscriptions immediately', async () => {
  const frames = new Set<unknown>(), states = new Set<unknown>()
  const client = { state: 'ready', send() {}, onFrame(fn: unknown) { frames.add(fn); return () => frames.delete(fn) },
    onState(fn: unknown) { states.add(fn); return () => states.delete(fn) } }
  const abort = new AbortController()
  const mounted = mountInlineOfficePanel({ container: document.createElement('aside'), client: client as any,
    clientId: 'c1' as any, documentId: 'd1' as any, captureSnapshot: () => ({ revision: 1 as any, selection: null }), signal: abort.signal,
  }).catch(() => undefined)
  abort.abort()
  expect(frames.size).toBe(0)
  expect(states.size).toBe(0)
  await mounted
})
