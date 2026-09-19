import { describe, expect, it, vi } from 'vitest'

import { documentRoute, loadBootstrap } from '../src/bootstrap'

describe('NexusDesk Web bootstrap', () => {
  it('returns an explicit reconnect action when authentication is missing', async () => {
    const state = await loadBootstrap(vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'authentication required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )))

    expect(state).toEqual({
      kind: 'unauthenticated',
      message: 'Your local NexusDesk session has expired.',
      reconnectHref: '/bootstrap/reconnect',
    })
  })

  it('lists documents returned by the authenticated Local Host', async () => {
    const state = await loadBootstrap(vi.fn().mockResolvedValue(Response.json({
      documents: [{
        documentId: 'document-1',
        title: 'Forecast.xlsx',
        editorType: 'sheets',
        revision: 3,
      }],
    })))

    expect(state).toEqual({
      kind: 'ready',
      documents: [{
        documentId: 'document-1',
        title: 'Forecast.xlsx',
        editorType: 'sheets',
        revision: 3,
      }],
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

    expect(href).toBe('/edit/sheets/document%20%2F%201')
    expect(href).not.toContain('Users')
    expect(href).not.toContain('Forecast.xlsx')
  })
})
