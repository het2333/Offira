import { describe, expect, it, vi } from 'vitest'

import { HostError } from '@nexusdesk/office-host'
import type { DocumentId } from '@nexusdesk/protocol'
import { createWebOfficeHost, type WebFetch, type WebSocketFactory } from '../src/web-office-host'

const bootstrap = {
  capabilities: {
    mode: 'browser',
    editors: ['sheets'],
    nativeFilePicker: false,
    browserImport: false,
    revealInFileManager: false,
    trash: false,
    updater: false,
    credentialStore: false,
  },
  documents: [{ documentId: 'd1', title: 'Forecast.xlsx', editorType: 'sheets', revision: 0 }],
  tabs: [
    { id: 'home', kind: 'home', title: 'Home', closable: false, active: true },
    {
      id: 'document:d1',
      kind: 'sheets',
      title: 'Forecast.xlsx',
      closable: true,
      active: false,
      documentId: 'd1',
    },
  ],
  settings: { language: 'zh', theme: 'system', onboardingSeen: true },
} as const

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createWebOfficeHost', () => {
  it('advertises the Docs and Sheets renderers that ship in the Web build', () => {
    expect(createWebOfficeHost().capabilities.editors).toEqual(['docs', 'sheets'])
  })

  it('parses bootstrap and sends tab mutations to the Host', async () => {
    const requests: Array<{ input: string; init: RequestInit | undefined }> = []
    const fetcher: WebFetch = (input, init) => {
      requests.push({ input, init })
      return Promise.resolve(json(bootstrap))
    }
    const host = createWebOfficeHost(fetcher)

    await expect(host.bootstrap()).resolves.toEqual(
      expect.objectContaining({
        tabs: expect.arrayContaining([expect.objectContaining({ id: 'home' })]),
      }),
    )
    await host.tabs.activate('document:d1')

    expect(requests.map((request) => request.input)).toContain('/api/shell/tabs/activate')
    expect(requests[1]?.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ tabId: 'document:d1' }),
    })
  })

  it('throws a typed unsupported-capability error without issuing a request', async () => {
    const requests: string[] = []
    const host = createWebOfficeHost((input) => {
      requests.push(input)
      return Promise.resolve(json(bootstrap))
    })

    await expect(host.platform.revealFile('f1')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    })
    expect(requests).toEqual([])
  })

  it('rejects malformed success payloads and converts Host errors', async () => {
    const malformed = createWebOfficeHost(() => Promise.resolve(json({ tabs: [] })))
    await expect(malformed.bootstrap()).rejects.toThrow()

    const failed = createWebOfficeHost(() =>
      Promise.resolve(
        json(
          {
            code: 'TAB_NOT_FOUND',
            message: 'Missing tab',
            retryable: false,
          },
          404,
        ),
      ),
    )
    await expect(failed.tabs.activate('missing')).rejects.toBeInstanceOf(HostError)
    await expect(failed.tabs.activate('missing')).rejects.toMatchObject({ code: 'TAB_NOT_FOUND' })
  })

  it('notifies local subscribers after a successful mutation', async () => {
    const active = {
      ...bootstrap,
      tabs: bootstrap.tabs.map((tab) => ({ ...tab, active: tab.id === 'document:d1' })),
    }
    const host = createWebOfficeHost(() => Promise.resolve(json(active)))
    const events: unknown[] = []
    const unsubscribe = host.tabs.onChanged((tabs) => events.push(tabs))

    await host.tabs.activate('document:d1')
    unsubscribe()

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.arrayContaining([expect.objectContaining({ active: true })]))
  })

  it('reports document save as unsupported instead of issuing an empty fake save', async () => {
    const requests: string[] = []
    const host = createWebOfficeHost((input) => {
      requests.push(input)
      return Promise.resolve(json(bootstrap))
    })

    await expect(host.documents.save('d1' as DocumentId)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      documentId: 'd1',
    })
    expect(requests).toEqual([])
  })

  it('refreshes subscribers when another client broadcasts a sequenced Shell change', async () => {
    const listeners = new Map<string, (event: { data?: string }) => void>()
    const socketFactory: WebSocketFactory = () => ({
      addEventListener(type, listener) {
        listeners.set(type, listener)
      },
      close() {},
    })
    const host = createWebOfficeHost(() => Promise.resolve(json(bootstrap)), socketFactory)
    const events: unknown[] = []
    host.tabs.onChanged((tabs) => events.push(tabs))

    listeners.get('message')?.({
      data: JSON.stringify({ type: 'shell:changed', protocolVersion: 1, sequence: 1 }),
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual(bootstrap.tabs)
  })

  it('refreshes authoritative Shell state when a replacement socket becomes ready', async () => {
    const sockets: Array<Map<string, (event: { data?: string }) => void>> = []
    const socketFactory: WebSocketFactory = () => {
      const listeners = new Map<string, (event: { data?: string }) => void>()
      sockets.push(listeners)
      return {
        addEventListener(type, listener) {
          listeners.set(type, listener)
        },
        close() {},
      }
    }
    let remoteActive = false
    const host = createWebOfficeHost(
      () =>
        Promise.resolve(
          json({
            ...bootstrap,
            tabs: bootstrap.tabs.map((tab) => ({
              ...tab,
              active: remoteActive ? tab.id === 'document:d1' : tab.id === 'home',
            })),
          }),
        ),
      socketFactory,
    )
    const events: unknown[] = []
    host.tabs.onChanged((tabs) => events.push(tabs))

    sockets[0]!.get('close')?.({})
    remoteActive = true
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 1_500 })
    sockets[1]!.get('message')?.({
      data: JSON.stringify({ type: 'server:ready', protocolVersion: 1, clientId: 'client-2' }),
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))

    expect(events.at(-1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'document:d1', active: true })]),
    )
  })
})
