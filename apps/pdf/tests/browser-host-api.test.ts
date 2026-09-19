import { describe, expect, it, vi } from 'vitest'

import {
  createHttpPdfBrowserTransport,
  createPdfBrowserApi,
  loadPdfBrowserBootstrap,
} from '../src/renderer/browser-host-api'

const bootstrap = {
  documentId: 'pdf-1',
  title: 'review.pdf',
  revision: 4,
  websocketUrl: 'ws://127.0.0.1:4312/ws',
  language: 'en',
  theme: 'system' as const,
  contentUrl: '/api/documents/pdf-1/content',
  capabilities: { saveInPlace: true, textReflow: false },
}

describe('PDF Local Web browser adapter', () => {
  it('loads the authorized bootstrap and saves only the active Host PDF', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(bootstrap), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    await expect(loadPdfBrowserBootstrap('pdf-1', fetcher)).resolves.toEqual(bootstrap)

    const fetchContent = vi
      .fn()
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3])))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ document: { documentId: 'pdf-1', title: 'review.pdf', editorType: 'pdf', revision: 5 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    const transport = createHttpPdfBrowserTransport(bootstrap, fetchContent)
    const updateRevision = vi.fn()
    const api = createPdfBrowserApi({ document: { ...bootstrap }, updateRevision }, transport)

    await expect(api.consumePending()).resolves.toBe('nexusdesk://pdf-1')
    await expect(api.readFile('nexusdesk://pdf-1')).resolves.toEqual(Uint8Array.from([1, 2, 3]).buffer)
    await expect(
      api.save({ path: 'nexusdesk://pdf-1', markups: [], drawings: [], formValues: [], stamps: [] }),
    ).resolves.toEqual({ ok: true })
    expect(updateRevision).toHaveBeenCalledWith(5)
    await expect(api.save({ path: '/arbitrary.pdf', markups: [], drawings: [], formValues: [], stamps: [] })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/authorized/i),
    })
  })

  it('reports native-only PDF capabilities as unavailable instead of fabricating a result', async () => {
    const api = createPdfBrowserApi(
      { document: { ...bootstrap }, updateRevision: vi.fn() },
      { readContent: vi.fn(), writeContent: vi.fn() },
    )

    await expect(api.validateTextEdits({ path: 'nexusdesk://pdf-1', edits: [] })).rejects.toMatchObject({
      code: 'UNAVAILABLE_IN_WEB',
    })
    await expect(api.extractPages({ path: 'nexusdesk://pdf-1', pages: [0], suggestedName: 'copy.pdf' })).rejects.toMatchObject({
      code: 'UNAVAILABLE_IN_WEB',
    })
  })
})
