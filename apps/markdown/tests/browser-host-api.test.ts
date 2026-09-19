import { describe, expect, it, vi } from 'vitest'

import {
  createMarkdownBrowserApi,
  installMarkdownBrowserHostApi,
  loadMarkdownBrowserBootstrap,
  type MarkdownBrowserBootstrap,
  type MarkdownBrowserTransport,
} from '../src/renderer/browser-host-api'

const source = new TextEncoder().encode('# Original\n')

function bootstrap(): MarkdownBrowserBootstrap {
  return {
    documentId: 'markdown-1234',
    title: 'Notes.md',
    revision: 1,
    websocketUrl: 'ws://127.0.0.1:43123/ws',
    language: 'en',
    theme: 'system',
    contentUrl: '/api/documents/markdown-1234/content',
    recoveryUrl: '/api/documents/markdown-1234/recovery',
  }
}

function transport(): MarkdownBrowserTransport & { writes: Array<{ bytes: Uint8Array; revision: number }>; recoveries: Array<{ bytes: Uint8Array; revision: number }> } {
  const writes: Array<{ bytes: Uint8Array; revision: number }> = []
  const recoveries: Array<{ bytes: Uint8Array; revision: number }> = []
  return {
    writes,
    recoveries,
    async readContent() {
      return source
    },
    async writeContent(bytes, revision) {
      writes.push({ bytes: new Uint8Array(bytes), revision })
      return { documentId: 'markdown-1234', title: 'Notes.md', editorType: 'markdown', revision: 2 }
    },
    async writeRecovery(bytes, revision) {
      recoveries.push({ bytes: new Uint8Array(bytes), revision })
    },
  }
}

describe('Markdown browser host API', () => {
  it('consumes the one authorized virtual file and saves text with the Host revision', async () => {
    const host = transport()
    const handle = installMarkdownBrowserHostApi(bootstrap(), { target: {}, transport: host })
    const api = createMarkdownBrowserApi(handle, host)

    await expect(api.consumePending()).resolves.toBe('nexusdesk://markdown-1234')
    await expect(api.consumePending()).resolves.toBeNull()
    await expect(api.readFile('nexusdesk://markdown-1234')).resolves.toBe('# Original\n')
    await expect(api.readFile('/tmp/other.md')).rejects.toMatchObject({ code: 'UNAVAILABLE_IN_WEB' })
    await expect(api.save({ text: '# Updated\n', imageSources: [], mode: 'save' })).resolves.toEqual({
      ok: true,
      path: 'nexusdesk://markdown-1234',
      writtenText: '# Updated\n',
    })
    expect(host.writes).toHaveLength(1)
    expect(host.writes[0]?.revision).toBe(1)
    expect(Array.from(host.writes[0]?.bytes ?? [])).toEqual(
      Array.from(new TextEncoder().encode('# Updated\n')),
    )
    expect(handle.document.revision).toBe(2)
  })

  it('uploads a recovery copy at the current revision without advancing it', async () => {
    const host = transport()
    const handle = installMarkdownBrowserHostApi(bootstrap(), { target: {}, transport: host })

    await handle.updateRecovery('# Unsaved\n')

    expect(host.recoveries).toHaveLength(1)
    expect(host.recoveries[0]?.revision).toBe(1)
    expect(Array.from(host.recoveries[0]?.bytes ?? [])).toEqual(
      Array.from(new TextEncoder().encode('# Unsaved\n')),
    )
    expect(handle.document.revision).toBe(1)
  })

  it('does not advance the revision after a rejected Host save', async () => {
    const host = transport()
    host.writeContent = vi.fn().mockRejectedValue(new Error('revision conflict'))
    const handle = installMarkdownBrowserHostApi(bootstrap(), { target: {}, transport: host })

    await expect(
      handle.api.save({ text: '# Updated\n', imageSources: [], mode: 'save' }),
    ).resolves.toEqual({ ok: false, error: 'revision conflict' })
    expect(handle.document.revision).toBe(1)
  })

  it('loads an authenticated bootstrap by encoded document id', async () => {
    const fetchBootstrap = vi.fn().mockResolvedValue(Response.json(bootstrap()))
    await expect(loadMarkdownBrowserBootstrap('markdown / 1', fetchBootstrap)).resolves.toEqual(
      bootstrap(),
    )
    expect(fetchBootstrap).toHaveBeenCalledWith('/api/documents/markdown%20%2F%201/bootstrap', {
      credentials: 'same-origin',
    })
  })
})
