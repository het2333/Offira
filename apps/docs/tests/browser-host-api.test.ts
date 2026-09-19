import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  createDocsBrowserDesktopApi,
  installDocsBrowserHostApi,
  loadDocsBrowserBootstrap,
  selectDocsHost,
  type DocsBrowserBootstrap,
  type DocsBrowserTransport,
} from '../src/renderer/browser-host-api'

const sourceBytes = new TextEncoder().encode('authorized docx bytes')
const nextBytes = new TextEncoder().encode('saved docx bytes')

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
