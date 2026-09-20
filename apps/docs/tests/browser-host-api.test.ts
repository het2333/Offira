import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'
import type { AgentServerFrame, ClientFrame, ClientId } from '@nexusdesk/protocol'
import type { NexusClient, NexusClientState } from '@nexusdesk/web-client'

import {
  createDocsBrowserDesktopApi,
  createHttpDocsBrowserTransport,
  installDocsBrowserHostApi,
  loadDocsBrowserBootstrap,
  selectDocsHost,
  type DocsBrowserBootstrap,
  type DocsBrowserTransport,
} from '../src/renderer/browser-host-api'

const sourceBytes = new TextEncoder().encode('authorized docx bytes')
const nextBytes = new TextEncoder().encode('saved docx bytes')

class FakeClient implements NexusClient {
  state: NexusClientState = 'ready'
  clientId = 'client-1' as ClientId
  readonly sent: ClientFrame[] = []
  connectCount = 0
  closeCount = 0
  private listeners = new Set<(frame: AgentServerFrame) => void>()

  connect() {
    this.connectCount += 1
  }
  close() {
    this.closeCount += 1
  }
  send(frame: ClientFrame) {
    this.sent.push(frame)
  }
  request(): Promise<AgentServerFrame> {
    throw new Error('not used')
  }
  onFrame(listener: (frame: AgentServerFrame) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(frame: AgentServerFrame) {
    for (const listener of this.listeners) listener(frame)
  }
  onState() {
    return () => undefined
  }
}

function bootstrap(): DocsBrowserBootstrap {
  return {
    documentId: 'docx-1234',
    title: 'Report.docx',
    revision: 1,
    websocketUrl: 'ws://127.0.0.1:43123/ws',
    language: 'en',
    theme: 'system',
    contentUrl: '/api/documents/docx-1234/content',
  }
}

function transport(): DocsBrowserTransport & {
  writes: Array<{ expectedRevision: number; bytes: Uint8Array }>
} {
  const writes: Array<{ expectedRevision: number; bytes: Uint8Array }> = []
  return {
    writes,
    async readContent() {
      return sourceBytes
    },
    async writeContent(bytes, expectedRevision) {
      writes.push({ expectedRevision, bytes: new Uint8Array(bytes) })
      return {
        documentId: 'docx-1234',
        title: 'Report.docx',
        editorType: 'docs',
        revision: expectedRevision + 1,
      }
    },
  }
}

describe('Docs browser DesktopApi', () => {
  it('uses the Host language and theme instead of renderer defaults', async () => {
    const localized = { ...bootstrap(), language: 'zh' as const, theme: 'dark' as const }
    const handle = installDocsBrowserHostApi(localized, {
      target: {},
      transport: transport(),
    })

    await expect(handle.desktopApi.getLanguage()).resolves.toBe('zh')
    await expect(handle.desktopApi.getTheme()).resolves.toBe('dark')
  })

  it('consumes the Host-authorized DOCX once and never opens a caller path', async () => {
    const host = transport()
    const handle = installDocsBrowserHostApi(bootstrap(), {
      target: {},
      transport: host,
    })
    const api = createDocsBrowserDesktopApi(handle, host)

    const opened = await api.consumePendingOpenDocx()

    expect(opened).toMatchObject({
      path: 'nexusdesk://docx-1234',
      name: 'Report.docx',
      hash: createHash('sha256').update(sourceBytes).digest('hex'),
    })
    expect(opened && 'data' in opened ? Array.from(new Uint8Array(opened.data)) : null).toEqual(
      Array.from(sourceBytes),
    )
    await expect(api.consumePendingOpenDocx()).resolves.toBeNull()
    await expect(api.openDocxPath('/tmp/other.docx')).rejects.toMatchObject({
      code: 'UNAVAILABLE_IN_WEB',
    })
  })

  it('writes to the authorized document with the current revision and advances after success', async () => {
    const host = transport()
    const handle = installDocsBrowserHostApi(bootstrap(), {
      target: {},
      transport: host,
    })
    const api = createDocsBrowserDesktopApi(handle, host)

    await expect(
      api.saveDocx('nexusdesk://docx-1234', nextBytes.buffer as ArrayBuffer),
    ).resolves.toEqual({ ok: true })

    expect(host.writes).toHaveLength(1)
    expect(host.writes[0]?.expectedRevision).toBe(1)
    expect(Array.from(host.writes[0]?.bytes ?? [])).toEqual(Array.from(nextBytes))
    expect(handle.document.revision).toBe(2)
  })

  it('does not advance the revision when the Host rejects a save', async () => {
    const host = transport()
    host.writeContent = vi.fn().mockRejectedValue(new Error('revision conflict'))
    const handle = installDocsBrowserHostApi(bootstrap(), {
      target: {},
      transport: host,
    })
    const api = createDocsBrowserDesktopApi(handle, host)

    await expect(
      api.saveDocx('nexusdesk://docx-1234', nextBytes.buffer as ArrayBuffer),
    ).resolves.toEqual({ ok: false, error: 'revision conflict' })
    expect(handle.document.revision).toBe(1)
  })
})

describe('Docs browser host lifecycle', () => {
  it('hydrates the version-bound working copy, restores dirty, and waits before registering', async () => {
    const current = {
      ...bootstrap(),
      workingCopy: {
        documentEpoch: 'epoch-1',
        workingRevision: 4,
        savedRevision: 1,
        sourceContentId: 'a'.repeat(64),
        checkpointId: 'checkpoint-4',
        dirty: true,
        recoveryState: 'ready' as const,
        contentUrl: '/api/documents/docx-1234/sources/' + 'a'.repeat(64) + '/content',
      },
    }
    const requested: string[] = []
    const fetcher = async (url: any) => {
      requested.push(String(url))
      return new Response(sourceBytes)
    }
    const client = new FakeClient()
    const handle = installDocsBrowserHostApi(current, {
      client,
      target: {},
      transport: createHttpDocsBrowserTransport(current, fetcher as typeof fetch),
    })
    expect(client.sent.filter((frame) => frame.type === 'editor:register')).toHaveLength(0)
    handle.attachEditor({} as never)
    const opened = await handle.desktopApi.consumePendingOpenDocx()
    expect(opened).toMatchObject({ recovered: true })
    expect(requested).toEqual([current.workingCopy.contentUrl])
    expect(client.sent.filter((frame) => frame.type === 'editor:register')).toHaveLength(0)
    handle.setHydrated()
    expect(client.sent.find((frame) => frame.type === 'editor:register')).toMatchObject({
      revision: 4,
      documentEpoch: 'epoch-1',
      sourceContentId: 'a'.repeat(64),
      restoredCheckpointId: 'checkpoint-4',
    })
    expect(handle.bridge.client().attached).toBe(false)
    handle.dispose()
  })

  it('rebootstraps a stale initial hydration and registers only after the newer source is loaded', async () => {
    const first = {
      ...bootstrap(),
      workingCopy: {
        documentEpoch: 'epoch-1',
        workingRevision: 4,
        savedRevision: 1,
        sourceContentId: 'a'.repeat(64),
        checkpointId: 'checkpoint-4',
        dirty: true,
        recoveryState: 'ready' as const,
        contentUrl: '/old-source',
      },
    }
    const next = {
      ...first,
      revision: 5,
      workingCopy: {
        ...first.workingCopy,
        workingRevision: 5,
        sourceContentId: 'b'.repeat(64),
        checkpointId: 'checkpoint-5',
        contentUrl: '/new-source',
      },
    }
    const requested: string[] = []
    const fetcher = async (url: any) => {
      requested.push(String(url))
      return String(url).endsWith('/bootstrap') ? Response.json(next) : new Response(nextBytes)
    }
    const client = new FakeClient()
    const handle = installDocsBrowserHostApi(first, {
      client,
      target: {},
      transport: transport(),
      fetch: fetcher as typeof fetch,
    })
    const opened: any[] = []
    handle.desktopApi.onOpenDocx((value) => opened.push(value))
    handle.attachEditor({} as never)
    handle.setHydrated()
    const registration = client.sent.find((frame) => frame.type === 'editor:register')!
    client.emit({
      type: 'recovery:required',
      protocolVersion: 1,
      id: registration.id,
      documentId: 'docx-1234',
      code: 'REVISION_CONFLICT',
      message: 'Head changed during hydration',
    } as never)
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    expect(requested).toEqual(['/api/documents/docx-1234/bootstrap', '/new-source'])
    expect(opened[0]).toMatchObject({ recovered: true })
    expect(client.sent.filter((frame) => frame.type === 'editor:register')).toHaveLength(1)
    expect(handle.bridge.client().attached).toBe(false)
    handle.setHydrated()
    expect(client.sent.at(-1)).toMatchObject({
      type: 'editor:register',
      revision: 5,
      sourceContentId: 'b'.repeat(64),
    })
    handle.dispose()
  })

  it('preserves a sidebar edit made before the first registration is confirmed', async () => {
    const current = {
      ...bootstrap(),
      workingCopy: {
        documentEpoch: 'epoch-1',
        workingRevision: 4,
        savedRevision: 1,
        sourceContentId: 'a'.repeat(64),
        checkpointId: 'checkpoint-4',
        dirty: true,
        recoveryState: 'ready' as const,
        contentUrl: '/source',
      },
    }
    let requests = 0
    const fetcher = async () => {
      requests++
      return Response.json(current)
    }
    const context = {
      editor: { getJSON: () => ({ type: 'doc' }) },
      doc: { parsed: {}, hash: 'source' },
      header: { text: 'Recovered header' },
    }
    const client = new FakeClient()
    const handle = installDocsBrowserHostApi(current, {
      client,
      target: {},
      transport: transport(),
      fetch: fetcher as typeof fetch,
    })
    handle.attachEditor({} as never, { context: () => context as never })
    handle.setHydrated()
    const registration = client.sent.find((frame) => frame.type === 'editor:register')!
    context.header = { text: 'New manual header' }
    client.emit({
      type: 'recovery:required',
      protocolVersion: 1,
      id: registration.id,
      documentId: 'docx-1234',
      code: 'REVISION_CONFLICT',
      message: 'Head changed',
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(requests).toBe(0)
    expect(context.header.text).toBe('New manual header')
    expect(handle.workingCopy?.dirty).toBe(true)
    handle.dispose()
  })

  it('allows hydration when the document exceeds the bounded approval snapshot size', () => {
    const current = {
      ...bootstrap(),
      workingCopy: {
        documentEpoch: 'epoch-1',
        workingRevision: 1,
        savedRevision: 1,
        sourceContentId: 'a'.repeat(64),
        checkpointId: null,
        dirty: false,
        recoveryState: 'ready' as const,
        contentUrl: '/source',
      },
    }
    const client = new FakeClient()
    const handle = installDocsBrowserHostApi(current, {
      client,
      target: {},
      transport: transport(),
    })
    handle.attachEditor({} as never, {
      context: () =>
        ({
          editor: { getJSON: () => ({ text: 'x'.repeat(5 * 1024 * 1024) }) },
          doc: { parsed: {}, hash: 'large-source' },
        }) as never,
    })
    expect(() => handle.setHydrated()).not.toThrow()
    expect(client.sent.some((frame) => frame.type === 'editor:register')).toBe(true)
    handle.dispose()
  })

  it('routes manual Save bytes through preparation and promotion without a legacy PUT', async () => {
    const current = {
      ...bootstrap(),
      workingCopy: {
        documentEpoch: 'epoch-1',
        workingRevision: 4,
        savedRevision: 1,
        sourceContentId: 'a'.repeat(64),
        checkpointId: 'checkpoint-4',
        dirty: true,
        recoveryState: 'ready' as const,
        contentUrl: '/recovered-source',
      },
    }
    const requests: Array<{ url: string; method?: string; body: any }> = []
    let operationId = ''
    const fetcher = async (url: any, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method, body: init?.body })
      if (String(url).endsWith('/manual-save-uploads')) {
        operationId = JSON.parse(String(init?.body)).operationId
        return Response.json({
          uploadId: 'upload-1',
          operationId,
          requestFingerprint: 'b'.repeat(64),
        })
      }
      if (String(url).endsWith('/parts/document'))
        return Response.json({
          partId: 'document',
          sha256: 'c'.repeat(64),
          byteLength: nextBytes.length,
        })
      if (String(url).endsWith('/commit'))
        return Response.json({
          persistence: {
            documentEpoch: 'epoch-1',
            operationId,
            requestFingerprint: 'b'.repeat(64),
            checkpointId: 'saved-5',
            blobHash: 'c'.repeat(64),
            workingRevision: 5,
            savedRevision: 2,
            dirty: false,
          },
        })
      throw new Error('Unexpected request: ' + url)
    }
    const legacy = transport()
    const handle = installDocsBrowserHostApi(current, {
      client: new FakeClient(),
      target: {},
      transport: legacy,
      fetch: fetcher as typeof fetch,
    })
    await expect(
      handle.desktopApi.saveDocx('nexusdesk://docx-1234', nextBytes.buffer as ArrayBuffer, true),
    ).resolves.toMatchObject({ ok: false })
    expect(requests).toHaveLength(0)
    await expect(
      handle.desktopApi.saveDocx('nexusdesk://docx-1234', nextBytes.buffer as ArrayBuffer),
    ).resolves.toMatchObject({ ok: true })
    expect(legacy.writes).toHaveLength(0)
    const binary = requests.find((request) => request.url.endsWith('/parts/document'))!
    expect(Array.from(new Uint8Array(await binary.body.arrayBuffer()))).toEqual(
      Array.from(nextBytes),
    )
    expect(handle.document.revision).toBe(5)
    expect(handle.workingCopy).toMatchObject({ dirty: false, savedRevision: 2 })
    handle.dispose()
  })

  it('routes an approved Agent Save through its own checkpoint reservation and delivers its save receipt', async () => {
    const current = {
      ...bootstrap(),
      workingCopy: {
        documentEpoch: 'epoch-1',
        workingRevision: 4,
        savedRevision: 1,
        sourceContentId: 'a'.repeat(64),
        checkpointId: 'checkpoint-4',
        dirty: true,
        recoveryState: 'ready' as const,
        contentUrl: '/recovered-source',
      },
    }
    const requests: Array<{ url: string; body: any }> = []
    const fetcher = async (url: any, init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body })
      if (String(url).endsWith('/operations/lookup')) return Response.json({ state: 'not-found' })
      if (String(url).endsWith('/checkpoint-uploads'))
        return Response.json({ uploadId: 'upload-1', requestFingerprint: 'b'.repeat(64) })
      if (String(url).endsWith('/parts/document'))
        return Response.json({
          partId: 'document',
          sha256: 'c'.repeat(64),
          byteLength: nextBytes.length,
        })
      if (String(url).endsWith('/commit'))
        return Response.json({
          persistence: {
            documentEpoch: 'epoch-1',
            operationId: 'save-1',
            requestFingerprint: 'b'.repeat(64),
            checkpointId: 'saved-5',
            blobHash: 'c'.repeat(64),
            workingRevision: 5,
            savedRevision: 2,
            dirty: false,
          },
        })
      throw new Error('Unexpected request: ' + url)
    }
    const client = new FakeClient()
    const legacy = transport()
    const handle = installDocsBrowserHostApi(current, {
      client,
      target: {},
      transport: legacy,
      fetch: fetcher as typeof fetch,
    })
    handle.attachEditor({
      saveSnapshot: () => 'recovered body + new manual header',
      save: async () => {
        const saved = await handle.desktopApi.saveDocx(
          'nexusdesk://docx-1234',
          nextBytes.buffer as ArrayBuffer,
        )
        return { ok: saved.ok, summary: 'saved', warnings: [] }
      },
    } as never)
    handle.setHydrated()
    const registered = client.sent.find((frame) => frame.type === 'editor:register')!
    client.emit({
      type: 'editor:registered',
      protocolVersion: 1,
      id: registered.id,
      documentId: 'docx-1234',
      revision: 4,
      documentEpoch: 'epoch-1',
      sourceContentId: 'a'.repeat(64),
    } as never)
    const target = {
      documentId: 'docx-1234',
      editorType: 'docs',
      clientId: 'client-1',
      sessionId: 'session-1',
      operationId: 'save-1',
      revision: 4,
    }
    client.emit({
      type: 'editor:request',
      id: 'propose',
      target,
      command: 'propose_save',
      arguments: {},
    } as never)
    await vi.waitFor(() =>
      expect(client.sent.some((frame) => frame.type === 'editor:result')).toBe(true),
    )
    const proposed = (client.sent.find((frame) => frame.type === 'editor:result') as any).result
      .data
    client.emit({
      type: 'editor:request',
      id: 'save',
      target,
      command: 'save_document',
      arguments: { snapshotHash: proposed.snapshotHash },
      approval: { id: 'approval-1', planHash: proposed.planHash },
    } as never)
    await vi.waitFor(() =>
      expect(
        client.sent.find((frame) => frame.type === 'editor:result' && frame.id === 'save'),
      ).toMatchObject({
        result: { ok: true },
        persistence: { operationId: 'save-1', dirty: false },
      }),
    )
    expect(
      JSON.parse(requests.find((request) => request.url.endsWith('/checkpoint-uploads'))!.body),
    ).toMatchObject({
      requestId: 'save',
      operationId: 'save-1',
      planHash: proposed.planHash,
      expectedWorkingRevision: 4,
    })
    expect(legacy.writes).toHaveLength(0)
    handle.dispose()
  })
  it('loads authenticated bootstrap metadata by encoded document id', async () => {
    const fetchBootstrap = vi.fn().mockResolvedValue(Response.json(bootstrap()))

    await expect(loadDocsBrowserBootstrap('docx / 1', fetchBootstrap)).resolves.toEqual(bootstrap())
    expect(fetchBootstrap).toHaveBeenCalledWith('/api/documents/docx%20%2F%201/bootstrap', {
      credentials: 'same-origin',
    })
  })

  it('installs and disposes the preload-shaped browser API', () => {
    const target: Record<string, unknown> = {}
    const handle = installDocsBrowserHostApi(bootstrap(), {
      target,
      transport: transport(),
    })

    expect(target.desktop).toBeDefined()
    expect(target.nexusdeskDocsHost).toBe(handle)
    expect(handle.capabilities).toMatchObject({
      openFile: false,
      saveInPlace: true,
      saveAs: false,
      print: false,
      zotero: false,
    })

    handle.dispose()
    expect(target).toEqual({})
  })

  it('owns the native Agent API and keeps its registration revision synchronized', () => {
    const target: Record<string, unknown> = {}
    const client = new FakeClient()
    const handle = installDocsBrowserHostApi(bootstrap(), {
      target,
      transport: transport(),
      client,
    })

    expect(target.agentApi).toBe(handle.bridge.agentApi)
    expect(client.connectCount).toBe(1)
    handle.updateRevision(2)
    expect(handle.document.revision).toBe(2)
    expect(client.sent.at(-1)).toMatchObject({ type: 'editor:revision', revision: 2 })

    handle.dispose()
    expect(target).toEqual({})
    expect(client.closeCount).toBe(1)
  })

  it('selects explicit local Web mode before an Electron preload', async () => {
    const browserHandle = { dispose: vi.fn() }
    const installBrowser = vi.fn().mockResolvedValue(browserHandle)

    await expect(
      selectDocsHost({
        search: '?host=local-web&documentId=docx-1234',
        electronApi: { getLanguage: vi.fn() },
        installBrowser,
      }),
    ).resolves.toEqual({ kind: 'local-web', handle: browserHandle })
    expect(installBrowser).toHaveBeenCalledWith('docx-1234')
  })

  it('rejects local Web mode without a document id', async () => {
    await expect(
      selectDocsHost({
        search: '?host=local-web',
        electronApi: undefined,
        installBrowser: vi.fn(),
      }),
    ).resolves.toEqual({
      kind: 'error',
      message: 'NexusDesk Docs could not start: local Web mode requires a document id.',
    })
  })
})
