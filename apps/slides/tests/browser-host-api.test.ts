import { describe, expect, it } from 'vitest'

import {
  createSlidesBrowserApi,
  installSlidesBrowserHostApi,
  type SlidesBrowserBootstrap,
  type SlidesBrowserTransport,
} from '../src/renderer/browser-host-api'

function bootstrap(): SlidesBrowserBootstrap {
  return {
    documentId: 'slides-1234',
    title: 'Deck.pptx',
    revision: 1,
    contentVersion: 1,
    websocketUrl: 'ws://127.0.0.1:43123/ws',
    language: 'en',
    theme: 'system',
  }
}

function transport(): SlidesBrowserTransport & { calls: Array<{ action: string; payload: unknown }> } {
  const calls: Array<{ action: string; payload: unknown }> = []
  return {
    calls,
    async execute(action, payload) {
      calls.push({ action, payload })
      if (action === 'slides:open') {
        return { path: 'nexusdesk://slides-1234', slides: [], size: { cx: 1, cy: 1 } }
      }
      if (action === 'slides:save') return { ok: true, revision: 2, slides: [] }
      if (action === 'slides:edit-text') return { nodes: [] }
      if (action === 'slides:content-state') return { contentVersion: 2 }
      if (action === 'slides:ui') return { slides: [], index: 1, contentVersion: 3 }
      throw new Error(`unexpected action: ${action}`)
    },
  }
}

describe('Slides browser host API', () => {
  it('opens once, sends text edits to the Host session, and saves with the current revision', async () => {
    const host = transport()
    const handle = installSlidesBrowserHostApi(bootstrap(), { target: {}, transport: host })
    const api = createSlidesBrowserApi(handle, host)

    await expect(api.consumePendingOpen(960)).resolves.toMatchObject({ path: 'nexusdesk://slides-1234' })
    await expect(api.consumePendingOpen(960)).resolves.toBeNull()
    await expect(api.editText({ slideIndex: 0, sourceId: 'title', paragraphs: [] })).resolves.toEqual({ nodes: [] })
    await expect(api.addBlankSlide({ sourceIndex: 0, fitWidthPx: 960 })).resolves.toMatchObject({ index: 1 })
    await expect(api.save()).resolves.toMatchObject({ ok: true, revision: 2 })

    expect(host.calls).toEqual([
      { action: 'slides:open', payload: { fitWidthPx: 960 } },
      { action: 'slides:edit-text', payload: { slideIndex: 0, sourceId: 'title', paragraphs: [] } },
      { action: 'slides:content-state', payload: {} },
      { action: 'slides:ui', payload: { action: 'add-slide', payload: { sourceIndex: 0, fitWidthPx: 960, clearText: true } } },
      { action: 'slides:save', payload: { expectedRevision: 1 } },
    ])
    expect(handle.document.revision).toBe(2)
    expect(handle.document.contentVersion).toBe(3)
  })
})
