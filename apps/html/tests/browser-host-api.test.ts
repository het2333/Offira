import { describe, expect, it, vi } from 'vitest'

import {
  createHtmlBrowserApi,
  installHtmlBrowserHostApi,
  loadHtmlBrowserBootstrap,
  type HtmlBrowserBootstrap,
  type HtmlBrowserTransport,
} from '../src/renderer/browser-host-api'

function bootstrap(): HtmlBrowserBootstrap {
  return { documentId: 'html-1', title: 'Page.html', revision: 1, websocketUrl: 'ws://127.0.0.1:43123/ws', language: 'en', theme: 'system', contentUrl: '/api/documents/html-1/content', previewUrl: '/api/documents/html-1/preview' }
}

function transport(): HtmlBrowserTransport & { writes: Array<{ text: string; revision: number }>; previews: string[] } {
  const writes: Array<{ text: string; revision: number }> = []
  const previews: string[] = []
  return {
    writes,
    previews,
    async readContent() { return new TextEncoder().encode('<h1>Initial</h1>') },
    async writeContent(bytes, revision) {
      writes.push({ text: new TextDecoder().decode(bytes), revision })
      return { documentId: 'html-1', title: 'Page.html', editorType: 'html', revision: revision + 1 }
    },
    async updatePreview(text) { previews.push(text) },
  }
}

describe('HTML browser host API', () => {
  it('loads only the authorized virtual file, updates preview, and saves with the current Host revision', async () => {
    const host = transport()
    const handle = installHtmlBrowserHostApi(bootstrap(), { target: {}, transport: host })
    const api = createHtmlBrowserApi(handle, host)
    await expect(api.consumePending()).resolves.toBe('nexusdesk://html-1')
    await expect(api.readFile('nexusdesk://html-1')).resolves.toBe('<h1>Initial</h1>')
    await expect(api.readFile('/tmp/other.html')).rejects.toMatchObject({ code: 'UNAVAILABLE_IN_WEB' })
    api.updatePreview('<h1>Preview</h1>')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(api.getPreviewInfo()).resolves.toEqual({ url: '/api/documents/html-1/preview' })
    expect(host.previews).toEqual(['<h1>Preview</h1>'])
    await expect(api.save({ text: '<h1>Updated</h1>', imageSources: [], mode: 'save' })).resolves.toEqual({ ok: true, path: 'nexusdesk://html-1' })
    expect(host.writes).toEqual([{ text: '<h1>Updated</h1>', revision: 1 }])
    expect(handle.document.revision).toBe(2)
  })

  it('keeps its revision when the Host rejects an in-place save', async () => {
    const host = transport()
    host.writeContent = vi.fn().mockRejectedValue(new Error('revision conflict'))
    const handle = installHtmlBrowserHostApi(bootstrap(), { target: {}, transport: host })
    await expect(handle.api.save({ text: '<p>x</p>', imageSources: [], mode: 'save' })).resolves.toEqual({ ok: false, error: 'revision conflict' })
    expect(handle.document.revision).toBe(1)
  })

  it('loads bootstrap metadata by an encoded document id', async () => {
    const fetchBootstrap = vi.fn().mockResolvedValue(Response.json(bootstrap()))
    await expect(loadHtmlBrowserBootstrap('html / 1', fetchBootstrap)).resolves.toEqual(bootstrap())
    expect(fetchBootstrap).toHaveBeenCalledWith('/api/documents/html%20%2F%201/bootstrap', { credentials: 'same-origin' })
  })
})
