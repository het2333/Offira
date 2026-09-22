import { describe, expect, it, vi } from 'vitest'

import {
  createSlidesBrowserApi,
  installSlidesBrowserHostApi,
  type SlidesBrowserBootstrap,
  type SlidesBrowserTransport,
} from '../src/renderer/browser-host-api'
import { setToastEmitter, type ToastData } from '../src/renderer/components/toast-bus'

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
      if (action === 'slides:apply-edit-script') return { slide: { index: 0, nodes: [] }, contentVersion: 4 }
      if (action === 'slides:apply-txn') return { applied: true, contentVersion: 5, records: [{ op: 'setText' }], slides: [] }
      throw new Error(`unexpected action: ${action}`)
    },
  }
}

describe('Slides browser host API', () => {
  it('reports an applied Agent edit as successful when only the canvas refresh fails', async () => {
    const listeners = new Set<(frame: any) => void>()
    const sent: any[] = []
    const toasts: ToastData[] = []
    setToastEmitter(toast => toasts.push(toast))
    const client = { state: 'ready', clientId: 'client', connect() {}, close() {}, send(frame: any) { sent.push(frame) },
      onState() { return () => {} }, onFrame(fn: any) { listeners.add(fn); return () => listeners.delete(fn) } } as any
    const host = { async execute(action: string, payload: any) {
      if (action === 'slides:apply-txn') return payload.dryRun ? { dryRun: true } : { applied: true, contentVersion: 2, records: [{ op: 'setText' }] }
      if (action === 'slides:read-presentation') throw Error('render endpoint unavailable')
      throw Error(action)
    } }
    const handle = installSlidesBrowserHostApi(bootstrap(), { target: {}, transport: host, client })
    try {
      const emit = (frame: any) => { for (const fn of listeners) fn(frame) }
      emit({ type: 'editor:attached', documentId: 'slides-1234' })
      const target = { sessionId: 'session', clientId: 'client', documentId: 'slides-1234', editorType: 'slides', revision: 1, operationId: 'refresh-failure' }
      emit({ type: 'editor:request', protocolVersion: 1, id: 'proposal', target, command: 'propose_ops', arguments: { ops: [{ op: 'setText', target: { slide: 0, el: 'e_2' }, paragraphs: [{ runs: [{ text: '新标题' }] }] }] } })
      await vi.waitFor(() => expect(sent.some(frame => frame.id === 'proposal')).toBe(true))
      const proposal = sent.find(frame => frame.id === 'proposal').result.data
      emit({ type: 'editor:request', protocolVersion: 1, id: 'apply', target, command: 'apply_ops', arguments: {}, approval: { id: 'approval', planHash: proposal.planHash } })
      await vi.waitFor(() => expect(sent.some(frame => frame.id === 'apply')).toBe(true))

      expect(sent.find(frame => frame.id === 'apply').result).toMatchObject({ ok: true, data: { contentVersion: 2 } })
      expect(handle.document.contentVersion).toBe(2)
      expect(toasts).toEqual([expect.objectContaining({ kind: 'error', text: expect.stringContaining('刷新') })])
    } finally {
      handle.dispose()
      setToastEmitter(null)
    }
  })
  it('reports an approved save as successful when only the canvas refresh fails', async () => {
    const listeners = new Set<(frame: any) => void>()
    const sent: any[] = []
    const toasts: ToastData[] = []
    setToastEmitter(toast => toasts.push(toast))
    const client = { state: 'ready', clientId: 'client', connect() {}, close() {}, send(frame: any) { sent.push(frame) },
      onState() { return () => {} }, onFrame(fn: any) { listeners.add(fn); return () => listeners.delete(fn) } } as any
    const host = { async execute(action: string) {
      if (action === 'slides:save') return { ok: true, revision: 2, slides: [] }
      if (action === 'slides:read-presentation') throw Error('render endpoint unavailable')
      throw Error(action)
    } }
    const handle = installSlidesBrowserHostApi(bootstrap(), { target: {}, transport: host, client })
    try {
      const emit = (frame: any) => { for (const fn of listeners) fn(frame) }
      emit({ type: 'editor:attached', documentId: 'slides-1234' })
      const target = { sessionId: 'session', clientId: 'client', documentId: 'slides-1234', editorType: 'slides', revision: 1, operationId: 'save-refresh-failure' }
      emit({ type: 'editor:request', protocolVersion: 1, id: 'propose-save', target, command: 'propose_save', arguments: {} })
      await vi.waitFor(() => expect(sent.some(frame => frame.id === 'propose-save')).toBe(true))
      const proposal = sent.find(frame => frame.id === 'propose-save').result.data
      emit({ type: 'editor:request', protocolVersion: 1, id: 'save', target, command: 'save_presentation', arguments: { inPlace: true, contentVersion: proposal.contentVersion }, approval: { id: 'approval', planHash: proposal.planHash } })
      await vi.waitFor(() => expect(sent.some(frame => frame.id === 'save')).toBe(true))

      expect(sent.find(frame => frame.id === 'save').result).toMatchObject({ ok: true })
      expect(handle.document.revision).toBe(2)
      expect(toasts).toEqual([expect.objectContaining({ kind: 'error', text: expect.stringContaining('刷新') })])
    } finally {
      handle.dispose()
      setToastEmitter(null)
    }
  })
  it('publishes refreshed render state to the canvas after an approved native Agent edit', async () => {
    const listeners = new Set<(frame: any) => void>()
    const sent: any[] = []
    const client = { state: 'ready', clientId: 'client', connect() {}, close() {}, send(frame: any) { sent.push(frame) },
      onState() { return () => {} }, onFrame(fn: any) { listeners.add(fn); return () => listeners.delete(fn) } } as any
    const updated = { slides: [{ index: 0, nodes: [{ text: '新标题' }] }], size: { cx: 100, cy: 60 } }
    const host = { async execute(action: string, payload: any) {
      if (action === 'slides:apply-txn') return payload.dryRun ? { dryRun: true } : { applied: true, contentVersion: 2, records: [{ op: 'setText' }] }
      if (action === 'slides:read-presentation') return updated
      throw Error(action)
    } }
    const handle = installSlidesBrowserHostApi(bootstrap(), { target: {}, transport: host, client })
    const changed: unknown[] = []
    const off = handle.slidesApi.onDeckChanged(value => changed.push(value))
    const emit = (frame: any) => { for (const fn of listeners) fn(frame) }
    emit({ type: 'editor:attached', documentId: 'slides-1234' })
    const target = { sessionId: 'session', clientId: 'client', documentId: 'slides-1234', editorType: 'slides', revision: 1, operationId: 'operation' }
    emit({ type: 'editor:request', protocolVersion: 1, id: 'proposal', target, command: 'propose_ops', arguments: { ops: [{ op: 'setText', target: { slide: 0, el: 'e_2' }, paragraphs: [{ runs: [{ text: '新标题' }] }] }] } })
    await vi.waitFor(() => expect(sent.some(frame => frame.id === 'proposal')).toBe(true))
    const proposal = sent.find(frame => frame.id === 'proposal').result.data
    emit({ type: 'editor:request', protocolVersion: 1, id: 'apply', target, command: 'apply_ops', arguments: {}, approval: { id: 'approval', planHash: proposal.planHash } })
    await vi.waitFor(() => expect(sent.some(frame => frame.id === 'apply')).toBe(true))
    expect(changed).toEqual([updated])
    off(); handle.dispose()
  })
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

  it('routes table, chart, image, and element clipboard commands to Local Host transactions', async () => {
    const host = transport()
    const handle = installSlidesBrowserHostApi(bootstrap(), { target: {}, transport: host })
    const api = createSlidesBrowserApi(handle, host)
    const box = { slideIndex: 0, xPx: 0, yPx: 0, wPx: 100, hPx: 100, fitWidthPx: 960 }

    await api.addTable({ ...box, rows: 2, cols: 2 })
    await api.addChart({ ...box, kind: 'bar', categories: ['Q1'], series: [{ name: 'Sales', values: [1] }] })
    await api.addImageBytes({ ...box, base64: 'iVBORw0KGgo=', ext: 'png' })
    await api.copyElements({ slideIndex: 0, sourceIds: ['shape-1'] })
    await api.pasteElements({ slideIndex: 0, fitWidthPx: 960 })
    await api.duplicateElements({ slideIndex: 0, sourceIds: ['shape-1'], dxPx: 10, dyPx: 10, fitWidthPx: 960 })

    expect(host.calls.filter((call) => call.action === 'slides:ui').map((call) => (call.payload as any).action)).toEqual([
      'add-table', 'add-chart', 'add-image-bytes', 'copy-elements', 'paste-elements', 'duplicate-elements',
    ])
  })

  it('runs legacy AI edit scripts and transactions through the Local Host transaction service', async () => {
    const host = transport()
    const handle = installSlidesBrowserHostApi(bootstrap(), { target: {}, transport: host })
    const api = createSlidesBrowserApi(handle, host)
    const editScript = { slideIndex: 0, fitWidthPx: 960, boxes: [], edits: [] }
    const transaction = { ops: [{ op: 'setText', target: { slide: 0, el: 'title' }, paragraphs: [] }] }

    await expect(api.applyEditScript(editScript)).resolves.toEqual({ slide: { index: 0, nodes: [] } })
    await expect(api.applyTxn(transaction)).resolves.toMatchObject({ applied: true, contentVersion: 5 })

    expect(host.calls).toEqual([
      { action: 'slides:apply-edit-script', payload: editScript },
      { action: 'slides:apply-txn', payload: transaction },
    ])
    expect(handle.document.contentVersion).toBe(5)
  })
})
