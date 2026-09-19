import { describe, expect, it, vi } from 'vitest'
import { PDF_WEB_CAPABILITIES } from '../src/shared/web-capabilities'

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
  capabilities: PDF_WEB_CAPABILITIES,
}

describe('PDF Local Web browser adapter', () => {
  it('routes page rewrites and image pixels without renderer paths, advancing Host revisions', async () => {
    let revision = 4
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith('page-image-png')
              ? { png: 'aGVsbG8=' }
              : {
                  document: {
                    documentId: 'pdf-1',
                    title: 'review.pdf',
                    editorType: 'pdf',
                    revision: ++revision,
                  },
                },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const updateRevision = vi.fn()
    const api = createPdfBrowserApi(
      { document: { ...bootstrap }, updateRevision },
      createHttpPdfBrowserTransport(bootstrap, fetcher),
    )
    await expect(
      api.insertBlankPage({ path: 'nexusdesk://pdf-1', afterPageIndex: 0 }),
    ).resolves.toEqual({ ok: true })
    await expect(
      api.setPageSize({ path: 'nexusdesk://pdf-1', width: 300, height: 400 }),
    ).resolves.toEqual({ ok: true })
    await expect(
      api.cropPages({
        path: 'nexusdesk://pdf-1',
        pages: [0],
        rect: { l: 0.1, t: 0.1, r: 0.9, b: 0.9 },
      }),
    ).resolves.toEqual({ ok: true })
    await expect(
      api.pageImagePng({ path: 'nexusdesk://pdf-1', pageIndex: 0, rect: [0, 0, 20, 20], scale: 3 }),
    ).resolves.toBe('aGVsbG8=')
    expect(updateRevision.mock.calls.map((call) => call[0])).toEqual([5, 6, 7])
    for (const call of fetcher.mock.calls)
      expect(JSON.parse((call[1] as RequestInit).body as string)).not.toHaveProperty('path')
    await expect(
      api.insertBlankPage({ path: '/other.pdf', afterPageIndex: 0 }),
    ).resolves.toMatchObject({ ok: false })
    await expect(
      api.pageImagePng({ path: '/other.pdf', pageIndex: 0, rect: [0, 0, 20, 20] }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE_IN_WEB' })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('does not dispatch when the explicit page or image capability is absent', async () => {
    const transport = { modifyPages: vi.fn(), pageImagePng: vi.fn() }
    const api = createPdfBrowserApi(
      {
        document: {
          ...bootstrap,
          capabilities: { ...PDF_WEB_CAPABILITIES, pageRewriting: false, imageEditing: false },
        },
        updateRevision: vi.fn(),
      },
      transport as never,
    )
    await expect(
      api.setPageSize({ path: 'nexusdesk://pdf-1', width: 300, height: 400 }),
    ).resolves.toMatchObject({ ok: false })
    await expect(
      api.pageImagePng({ path: 'nexusdesk://pdf-1', pageIndex: 0, rect: [0, 0, 20, 20] }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE_IN_WEB' })
    expect(transport.modifyPages).not.toHaveBeenCalled()
    expect(transport.pageImagePng).not.toHaveBeenCalled()
  })
  it('loads the authorized bootstrap and saves only the active Host PDF', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(bootstrap), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    await expect(loadPdfBrowserBootstrap('pdf-1', fetcher)).resolves.toEqual(bootstrap)

    const fetchContent = vi
      .fn()
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3])))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            document: { documentId: 'pdf-1', title: 'review.pdf', editorType: 'pdf', revision: 5 },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    const transport = createHttpPdfBrowserTransport(bootstrap, fetchContent)
    const updateRevision = vi.fn()
    const api = createPdfBrowserApi({ document: { ...bootstrap }, updateRevision }, transport)

    await expect(api.consumePending()).resolves.toBe('nexusdesk://pdf-1')
    await expect(api.readFile('nexusdesk://pdf-1')).resolves.toEqual(
      Uint8Array.from([1, 2, 3]).buffer,
    )
    await expect(
      api.save({
        path: 'nexusdesk://pdf-1',
        markups: [],
        drawings: [],
        formValues: [],
        stamps: [],
      }),
    ).resolves.toEqual({ ok: true })
    expect(updateRevision).toHaveBeenCalledWith(5)
    await expect(
      api.save({ path: '/arbitrary.pdf', markups: [], drawings: [], formValues: [], stamps: [] }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/authorized/i),
    })
    await expect(api.canDrawText('NexusDesk')).resolves.toBe(true)
  })

  it('reports native-only PDF capabilities as unavailable instead of fabricating a result', async () => {
    const api = createPdfBrowserApi(
      { document: { ...bootstrap }, updateRevision: vi.fn() },
      { readContent: vi.fn(), writeContent: vi.fn() },
    )

    await expect(
      api.validateTextEdits({ path: 'nexusdesk://pdf-1', edits: [] }),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE_IN_WEB',
    })
    await expect(
      api.extractPages({ path: 'nexusdesk://pdf-1', pages: [0], suggestedName: 'copy.pdf' }),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE_IN_WEB',
    })
  })
})
