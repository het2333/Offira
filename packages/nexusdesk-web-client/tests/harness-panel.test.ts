// @vitest-environment jsdom

import type { ClientId, DocumentId, Revision } from '@nexusdesk/protocol'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createHarnessTransport } from '../src/harness-transport'
import { mountHarnessPanel } from '../src/harness-panel'
import type { NexusClient } from '../src/client'

vi.mock('../src/harness-transport', () => ({
  createHarnessTransport: vi.fn(),
}))

interface TestCapability {
  readonly rpc: object
  readonly binding: {
    readonly sessionId: string
    captureSubmission(requestId: string): void
  }
  onReady(): void
  onError(): void
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function capability(container: HTMLElement): TestCapability {
  const iframe = container.querySelector('iframe') as HTMLIFrameElement & {
    __NEXUSD_OFFICE__: TestCapability
  }
  return iframe.__NEXUSD_OFFICE__
}

describe('mountHarnessPanel', () => {
  const client = { state: 'ready' } as NexusClient
  const clientId = 'client one' as ClientId
  const documentId = 'document/one' as DocumentId
  const rpc = { call: vi.fn(), open: vi.fn() }
  const captureSubmission = vi.fn()
  const disposeTransport = vi.fn()

  beforeEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  function mockTransport(bind: () => Promise<string>) {
    vi.mocked(createHarnessTransport).mockReturnValue({
      bind,
      rpc,
      captureSubmission,
      dispose: disposeTransport,
    } as unknown as ReturnType<typeof createHarnessTransport>)
  }

  test('prevents official boot before bind and installs the exact capability before append', async () => {
    const binding = deferred<string>()
    mockTransport(() => binding.promise)
    const container = document.createElement('div')
    const append = vi.spyOn(container, 'appendChild')

    const mounted = mountHarnessPanel({
      container,
      client,
      clientId,
      documentId,
      captureSnapshot: () => ({ revision: 3 as Revision, selection: { kind: 'sheets' } }),
    })

    expect(createHarnessTransport).toHaveBeenCalledWith(client, documentId)
    expect(append).not.toHaveBeenCalled()

    binding.resolve('session-1')
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    const installed = capability(container)
    expect(iframe.getAttribute('src')).toBe(
      '/harness/index.html?clientId=client+one&documentId=document%2Fone',
    )
    expect(installed.rpc).toBe(rpc)
    expect(installed.binding.sessionId).toBe('session-1')
    expect(append.mock.calls[0]?.[0]).toBe(iframe)

    installed.onReady()
    const dispose = await mounted
    dispose()
  })

  test('prevents selection drift by cloning a fresh snapshot for every request id', async () => {
    mockTransport(async () => 'session-2')
    const container = document.createElement('div')
    let snapshot = {
      revision: 4 as Revision,
      selection: { kind: 'sheets', sheetId: 'sheet-1', a1: 'A1', columns: ['Name'] },
    }
    const mounted = mountHarnessPanel({
      container,
      client,
      clientId,
      documentId,
      captureSnapshot: () => snapshot,
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const installed = capability(container)

    installed.binding.captureSubmission('request-1')
    snapshot.selection.columns[0] = 'Changed after capture'
    snapshot = {
      revision: 5 as Revision,
      selection: { kind: 'sheets', sheetId: 'sheet-2', a1: 'C3', columns: ['Amount'] },
    }
    installed.binding.captureSubmission('request-2')

    expect(captureSubmission).toHaveBeenNthCalledWith(1, 'request-1', {
      revision: 4,
      selection: { kind: 'sheets', sheetId: 'sheet-1', a1: 'A1', columns: ['Name'] },
    })
    expect(captureSubmission).toHaveBeenNthCalledWith(2, 'request-2', {
      revision: 5,
      selection: { kind: 'sheets', sheetId: 'sheet-2', a1: 'C3', columns: ['Amount'] },
    })
    expect(captureSubmission.mock.calls[0]?.[1]).not.toBe(snapshot)

    installed.onReady()
    const dispose = await mounted
    dispose()
  })

  test('prevents a failed iframe from retaining transport and shows a Chinese recovery message', async () => {
    mockTransport(async () => 'session-3')
    const container = document.createElement('div')
    const mounted = mountHarnessPanel({
      container,
      client,
      clientId,
      documentId,
      captureSnapshot: () => ({ revision: 1 as Revision, selection: {} }),
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

    const rejected = expect(mounted).rejects.toThrow(/文档助手/)
    capability(container).onError()

    await rejected
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toMatch(/文档助手.*重新打开/)
    expect(disposeTransport).toHaveBeenCalledOnce()
  })

  test('shows the same explicit recovery state when authenticated binding fails', async () => {
    mockTransport(async () => {
      throw new Error('not authenticated')
    })
    const container = document.createElement('div')

    await expect(
      mountHarnessPanel({
        container,
        client,
        clientId,
        documentId,
        captureSnapshot: () => ({ revision: 1 as Revision, selection: {} }),
      }),
    ).rejects.toThrow(/文档助手/)

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toMatch(/文档助手.*重新打开/)
    expect(disposeTransport).toHaveBeenCalledOnce()
  })

  test('prevents infinite loading by timing out readiness and cleaning the failed mount', async () => {
    vi.useFakeTimers()
    try {
      mockTransport(async () => 'session-4')
      const container = document.createElement('div')
      const mounted = mountHarnessPanel({
        container,
        client,
        clientId,
        documentId,
        captureSnapshot: () => ({ revision: 1 as Revision, selection: {} }),
        readyTimeoutMs: 500,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(container.querySelector('iframe')).not.toBeNull()

      const rejected = expect(mounted).rejects.toThrow(/连接超时/)
      await vi.advanceTimersByTimeAsync(500)

      await rejected
      expect(container.querySelector('iframe')).toBeNull()
      expect(disposeTransport).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  test('prevents duplicate cleanup when the returned disposer runs more than once', async () => {
    mockTransport(async () => 'session-5')
    const container = document.createElement('div')
    const mounted = mountHarnessPanel({
      container,
      client,
      clientId,
      documentId,
      captureSnapshot: () => ({ revision: 1 as Revision, selection: {} }),
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    capability(container).onReady()
    const dispose = await mounted

    dispose()
    dispose()

    expect(container.querySelector('iframe')).toBeNull()
    expect(disposeTransport).toHaveBeenCalledOnce()
  })

  test('prevents a pending bind from surviving an unmount abort', async () => {
    const binding = deferred<string>()
    mockTransport(() => binding.promise)
    const container = document.createElement('div')
    const abort = new AbortController()
    const mounted = mountHarnessPanel({
      container,
      client,
      clientId,
      documentId,
      captureSnapshot: () => ({ revision: 1 as Revision, selection: {} }),
      signal: abort.signal,
    })
    const rejected = expect(mounted).rejects.toMatchObject({ name: 'AbortError' })

    abort.abort()
    binding.resolve('late-session')

    await rejected
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toBe('')
    expect(disposeTransport).toHaveBeenCalledOnce()
  })

  test('cleans a runtime iframe failure that arrives after readiness', async () => {
    mockTransport(async () => 'session-6')
    const container = document.createElement('div')
    const mounted = mountHarnessPanel({
      container,
      client,
      clientId,
      documentId,
      captureSnapshot: () => ({ revision: 1 as Revision, selection: {} }),
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const installed = capability(container)
    installed.onReady()
    await mounted

    installed.onError()

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toMatch(/文档助手.*重新打开/)
    expect(disposeTransport).toHaveBeenCalledOnce()
  })
})
