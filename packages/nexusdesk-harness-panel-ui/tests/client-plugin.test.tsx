/** @vitest-environment jsdom */
import { Context } from '@deepseek-ai/cordis'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ISessions,
  SessionBinding,
  SessionReference,
  SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installOfficePanelBinding } from '../src/binding.ts'
import {
  OFFICE_PANEL_CONTENT_SLOT,
  OFFICE_PANEL_PRIMARY_PRIORITY,
  OFFICE_PANEL_FALLBACK_PRIORITY,
  apply,
} from '../src/client.tsx'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

function snapshot(sessionId: string, requestIds: readonly string[] = []): SessionSnapshot {
  return {
    sessionId: sessionId as SessionId,
    pendingSubmissions: requestIds.map((requestId) => ({
      requestId: requestId as never,
      placement: 'transcript',
      time: 1,
      text: requestId,
      attachments: [],
    })),
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: requestIds.length > 0,
    awaitingFirstTurn: false,
  }
}

function referenceHarness(sessionId = 'session-1') {
  let value = snapshot(sessionId)
  const listeners = new Set<() => void>()
  const session = {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const binding = {
    sessionId: sessionId as SessionId,
    session,
    eventSource: {},
    ctx: new Context(),
  } as unknown as SessionBinding
  const release = vi.fn()
  const reference = {
    sessionId: sessionId as SessionId,
    binding,
    ready: Promise.resolve(binding),
    release,
    [Symbol.dispose]: release,
  } as SessionReference
  return {
    reference,
    release,
    listenerCount: () => listeners.size,
    publish: (requestIds: readonly string[]) => {
      value = snapshot(sessionId, requestIds)
      queueMicrotask(() => {
        for (const listener of listeners) listener()
      })
    },
  }
}

async function boot(reference: SessionReference) {
  const slots = new SlotCore()
  const effects: Array<() => void> = []
  const retain = vi.fn(() => reference)
  const genericWorkbench = (): string => 'generic workbench'
  slots.register({ name: 'root', priority: 0 }, genericWorkbench)
  const ctx = {
    sessions: { retain } as unknown as ISessions,
    slots: {
      register: (...args: unknown[]) => {
        const register = slots.register as unknown as (...values: unknown[]) => () => void
        const dispose = register.call(slots, ...args)
        effects.push(dispose)
        return dispose
      },
    },
    effect: (execute: () => () => void) => {
      const dispose = execute()
      effects.push(dispose)
      return { dispose }
    },
  } as unknown as Context
  await apply(ctx)
  return {
    slots,
    retain,
    genericWorkbench,
    dispose: async () => {
      for (const dispose of effects.reverse()) dispose()
    },
  }
}

const bindingDisposers: Array<() => void> = []

afterEach(() => {
  while (bindingDisposers.length > 0) bindingDisposers.pop()?.()
  document.body.replaceChildren()
})

describe('official Office conversation composition', () => {
  it('retains the carrier Session and registers primary plus independent fallback roots ahead of AppFrame', async () => {
    const harness = referenceHarness()
    const captureSubmission = vi.fn()
    bindingDisposers.push(
      installOfficePanelBinding({
        sessionId: 'session-1',
        captureSubmission,
      }),
    )

    const bench = await boot(harness.reference)
    expect(bench.retain).toHaveBeenCalledWith('session-1', { source: 'officePanel' })
    expect(bench.slots.spec(OFFICE_PANEL_CONTENT_SLOT)).toEqual({
      kind: 'single',
      scope: 'session-maybe',
    })
    expect(bench.slots.entries('root').map((entry) => entry.options.priority)).toEqual([
      OFFICE_PANEL_PRIMARY_PRIORITY,
      OFFICE_PANEL_FALLBACK_PRIORITY,
      0,
    ])
    expect(bench.slots.entriesOfSlot('root')[0]?.options.priority).toBe(
      OFFICE_PANEL_PRIMARY_PRIORITY,
    )
    expect(harness.listenerCount()).toBe(1)

    const primary = bench.slots.entriesOfSlot('root')[0]
    if (primary === undefined) throw new Error('missing Office primary root')
    bench.slots.reportEntryError('root', primary, new Error('primary crashed'), { abdicate: true })
    expect(bench.slots.entriesOfSlot('root')[0]?.options.priority).toBe(
      OFFICE_PANEL_FALLBACK_PRIORITY,
    )

    await bench.dispose()
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(harness.listenerCount()).toBe(0)
  })

  it('renders only the embedded official conversation factory contract', async () => {
    const harness = referenceHarness()
    bindingDisposers.push(
      installOfficePanelBinding({
        sessionId: 'session-1',
        captureSubmission: vi.fn(),
      }),
    )
    const bench = await boot(harness.reference)
    const content = bench.slots.entries(OFFICE_PANEL_CONTENT_SLOT)[0]?.component as (
      props: object,
    ) => unknown
    const renderFactorySlot = vi.fn(() => 'official conversation')

    expect(content({ renderFactorySlot })).toBe('official conversation')
    expect(renderFactorySlot).toHaveBeenCalledWith(
      'conversation.content',
      { variant: 'embedded', phase: 'active', hero: false },
      expect.objectContaining({ fallback: expect.anything() }),
    )
    await bench.dispose()
  })

  it('releases Session ownership when the rendered Office root unmounts', async () => {
    const harness = referenceHarness()
    bindingDisposers.push(
      installOfficePanelBinding({
        sessionId: 'session-1',
        captureSubmission: vi.fn(),
      }),
    )
    const bench = await boot(harness.reference)
    const primary = bench.slots
      .entries('root')
      .find((entry) => entry.options.priority === OFFICE_PANEL_PRIMARY_PRIORITY)?.component as (
      props: object,
    ) => unknown
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let providerSession: unknown

    await act(async () => {
      root.render(
        createElement(primary as never, {
          renderSlot: () => 'official conversation',
          SessionProvider: ({ children, session }: { children: unknown; session?: unknown }) => {
            providerSession = session
            return children
          },
        }),
      )
    })
    expect(container.querySelector('[data-nexusdesk-office-panel="ready"]')).not.toBeNull()
    expect(providerSession).toBe(harness.reference)

    await act(async () => root.unmount())
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(harness.listenerCount()).toBe(0)
    await bench.dispose()
    expect(harness.release).toHaveBeenCalledTimes(1)
  })

  it('fails closed inside the Office root when a rendered child crashes', async () => {
    const harness = referenceHarness()
    bindingDisposers.push(
      installOfficePanelBinding({
        sessionId: 'session-1',
        captureSubmission: vi.fn(),
      }),
    )
    const bench = await boot(harness.reference)
    const primary = bench.slots
      .entries('root')
      .find((entry) => entry.options.priority === OFFICE_PANEL_PRIMARY_PRIORITY)?.component as (
      props: object,
    ) => unknown
    const container = document.createElement('div')
    const root = createRoot(container)
    const Thrower = (): never => {
      throw new Error('factory render failed')
    }

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      root.render(
        createElement(primary as never, {
          renderSlot: () => <Thrower />,
          SessionProvider: ({ children }: { children: unknown }) => children,
        }),
      )
    })
    consoleError.mockRestore()
    expect(container.querySelector('[data-nexusdesk-office-panel="failed"]')?.textContent).toMatch(
      /无法连接.*重新打开面板/,
    )
    expect(container.textContent).not.toContain('generic workbench')

    await act(async () => root.unmount())
    await bench.dispose()
  })

  it('rejects missing and mismatched Session bindings without exposing a root', async () => {
    const missing = referenceHarness()
    await expect(boot(missing.reference)).rejects.toThrow(/binding.*before.*boot/i)
    expect(missing.release).not.toHaveBeenCalled()

    const wrong = referenceHarness('other-session')
    bindingDisposers.push(
      installOfficePanelBinding({
        sessionId: 'session-1',
        captureSubmission: vi.fn(),
      }),
    )
    await expect(boot(wrong.reference)).rejects.toThrow(/expected.*session-1.*other-session/i)
    expect(wrong.release).toHaveBeenCalledTimes(1)
  })

  it('turns capture errors into the same fail-closed root without leaking the generic workbench', async () => {
    const harness = referenceHarness()
    bindingDisposers.push(
      installOfficePanelBinding({
        sessionId: 'session-1',
        captureSubmission: () => {
          throw new Error('selection capture failed')
        },
      }),
    )
    const bench = await boot(harness.reference)
    const primary = bench.slots
      .entries('root')
      .find((entry) => entry.options.priority === OFFICE_PANEL_PRIMARY_PRIORITY)?.component as (
      props: object,
    ) => unknown
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(primary as never, {
          renderSlot: () => 'official conversation',
          SessionProvider: ({ children }: { children: unknown }) => children,
        }),
      )
    })

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.publish(['request-a'])
    await act(async () => {
      await Promise.resolve()
    })
    consoleError.mockRestore()
    expect(container.querySelector('[data-nexusdesk-office-panel="failed"]')).not.toBeNull()
    expect(container.textContent).not.toContain('generic workbench')

    await act(async () => root.unmount())
    await bench.dispose()
  })
})
