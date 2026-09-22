import { describe, expect, it, vi } from 'vitest'

import { documentRoute, loadBootstrap, type WebDocumentSummary } from '../src/bootstrap'

describe('NexusDesk Web bootstrap', () => {
  it('returns an explicit reconnect action when authentication is missing', async () => {
    const state = await loadBootstrap(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    expect(state).toEqual({
      kind: 'unauthenticated',
      message: 'Your local Offira session has expired.',
      reconnectHref: '/bootstrap/reconnect',
    })
  })

  it('lists documents returned by the authenticated Local Host', async () => {
    const fetchBootstrap = vi.fn().mockResolvedValue(
      Response.json({
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
        documents: [
          {
            documentId: 'document-1',
            title: 'Forecast.xlsx',
            editorType: 'sheets',
            revision: 3,
          },
        ],
        tabs: [{ id: 'home', kind: 'home', title: 'Home', closable: false, active: true }],
        settings: { language: 'zh', theme: 'system', onboardingSeen: true },
      }),
    )
    const state = await loadBootstrap(fetchBootstrap)

    expect(state).toEqual({
      kind: 'ready',
      documents: [
        {
          documentId: 'document-1',
          title: 'Forecast.xlsx',
          editorType: 'sheets',
          revision: 3,
        },
      ],
    })
    expect(fetchBootstrap).toHaveBeenCalledWith('/api/shell/bootstrap', {
      credentials: 'same-origin',
    })
  })

  it('builds editor navigation from the stable document id and never the file path', () => {
    const href = documentRoute({
      documentId: 'document / 1',
      title: 'Forecast.xlsx',
      editorType: 'sheets',
      revision: 1,
      path: '/Users/example/secret/Forecast.xlsx',
    })

    expect(href).toBe('/sheets/?host=local-web&documentId=document%20%2F%201')
    expect(href).not.toContain('Users')
    expect(href).not.toContain('Forecast.xlsx')
  })

  it('builds the PDF editor route from the same authorized document id', () => {
    expect(
      documentRoute({ documentId: 'pdf-1', title: 'review.pdf', editorType: 'pdf', revision: 1 }),
    ).toBe('/pdf/?host=local-web&documentId=pdf-1')
  })

  it.each([
    ['slides', '/slides/?host=local-web&documentId=slides-1'],
    ['markdown', '/markdown/?host=local-web&documentId=markdown-1'],
    ['html', '/html/?host=local-web&documentId=html-1'],
  ] satisfies Array<[WebDocumentSummary['editorType'], string]>)(
    'builds the %s editor route from the authorized document id',
    (editorType, expected) => {
      expect(
        documentRoute({
          documentId: `${editorType}-1`,
          title: `document.${editorType}`,
          editorType,
          revision: 1,
        }),
      ).toBe(expected)
    },
  )
})
