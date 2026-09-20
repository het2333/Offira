import { describe, expect, it, vi } from 'vitest'
import { PDF_WEB_CAPABILITIES } from '../src/shared/web-capabilities'
import { PDF_WEB_IMAGE_BASE64_LIMIT } from '@nexusdesk/protocol'

import {
  createHttpPdfBrowserTransport,
  createPdfBrowserApi,
  loadPdfBrowserBootstrap,
  installPdfBrowserHostApi,
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
  it('keeps the leased source and dirty editor when recovery would overwrite local drafts', async () => {
    const frames = new Set<(frame: any) => void>()
    const client = {
      state: 'ready',
      clientId: 'client',
      connect() {},
      close() {},
      send() {},
      onFrame(listener: (frame: any) => void) {
        frames.add(listener)
        return () => frames.delete(listener)
      },
      onState() {
        return () => {}
      },
    }
    const workingCopy = {
      documentEpoch: 'epoch',
      workingRevision: 4,
      savedRevision: 4,
      sourceContentId: 'a'.repeat(64),
      checkpointId: null,
      dirty: false,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    }
    let loads = 0
    const handle = installPdfBrowserHostApi(
      { ...bootstrap, workingCopy },
      {
        client: client as never,
        target: {},
        fetch: async () =>
          Response.json({
            ...bootstrap,
            workingCopy: { ...workingCopy, sourceContentId: 'b'.repeat(64) },
          }),
      },
    )
    handle.attachEditor({
      snapshot: vi.fn(),
      read: vi.fn(),
      propose: vi.fn(),
      proposeSave: vi.fn(),
      apply: vi.fn(),
      save: vi.fn(),
      prepareRecovery: () => {
        throw Object.assign(Error('Unsaved drafts are preserved'), {
          code: 'PDF_RECOVERY_LOCAL_CHANGES',
        })
      },
      restoreWorkingCopy: async () => {
        loads++
      },
    })
    handle.setHydrated(workingCopy.sourceContentId)
    for (const listener of frames)
      listener({
        type: 'recovery:required',
        documentId: 'pdf-1',
        code: 'STALE_PLAN',
        message: 'stale',
      })
    await vi.waitFor(() => expect(handle.reloadError).toContain('preserved'))
    expect(handle.document.workingCopy!.sourceContentId).toBe('a'.repeat(64))
    expect(loads).toBe(0)
    expect(handle.hydrated).toBe(false)
    handle.dispose()
  })

  it('retains the recovery loader across a transient bootstrap error and renderer detachment', async () => {
    const frames = new Set<(frame: any) => void>()
    const client = {
      state: 'ready',
      clientId: 'client',
      connect() {},
      close() {},
      send() {},
      onFrame(listener: (frame: any) => void) {
        frames.add(listener)
        return () => frames.delete(listener)
      },
      onState() {
        return () => {}
      },
    }
    const workingCopy = {
      documentEpoch: 'epoch',
      workingRevision: 4,
      savedRevision: 4,
      sourceContentId: 'a'.repeat(64),
      checkpointId: null,
      dirty: false,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    }
    let bootstraps = 0
    let loads = 0
    const handle = installPdfBrowserHostApi(
      { ...bootstrap, workingCopy },
      {
        client: client as never,
        target: {},
        fetch: async () => {
          if (++bootstraps === 1) throw Error('temporary connection failure')
          return Response.json({ ...bootstrap, workingCopy })
        },
      },
    )
    const detach = handle.attachEditor({
      snapshot: vi.fn(),
      read: vi.fn(),
      propose: vi.fn(),
      proposeSave: vi.fn(),
      apply: vi.fn(),
      save: vi.fn(),
      restoreWorkingCopy: async () => {
        loads++
        handle.setHydrated(workingCopy.sourceContentId)
      },
    })
    handle.onWorkingCopyState(() => {
      if (handle.reloadError) detach()
    })
    handle.setHydrated(workingCopy.sourceContentId)
    for (const listener of frames)
      listener({
        type: 'recovery:required',
        documentId: 'pdf-1',
        code: 'REVISION_CONFLICT',
        message: 'stale',
      })
    await vi.waitFor(() => expect(loads).toBe(1))
    expect(bootstraps).toBe(2)
    expect(handle.reloadError).toBeUndefined()
    handle.dispose()
  })
  it('automatically rehydrates a stale source and stops after three unsuccessful recoveries', async () => {
    const sent: any[] = []
    const frames = new Set<(frame: any) => void>()
    const client = {
      state: 'ready',
      clientId: 'client',
      connect() {},
      close() {},
      send(frame: unknown) {
        sent.push(frame)
      },
      onFrame(listener: (frame: any) => void) {
        frames.add(listener)
        return () => frames.delete(listener)
      },
      onState() {
        return () => {}
      },
    }
    const workingCopy = {
      documentEpoch: 'epoch',
      workingRevision: 4,
      savedRevision: 4,
      sourceContentId: 'a'.repeat(64),
      checkpointId: null,
      dirty: false,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    }
    let loads = 0
    let bootstraps = 0
    const handle = installPdfBrowserHostApi(
      { ...bootstrap, workingCopy },
      {
        client: client as never,
        target: {},
        fetch: async () => {
          bootstraps++
          return Response.json({
            ...bootstrap,
            workingCopy: { ...workingCopy, sourceContentId: 'b'.repeat(64) },
          })
        },
      },
    )
    handle.attachEditor({
      snapshot: vi.fn(),
      read: vi.fn(),
      propose: vi.fn(),
      proposeSave: vi.fn(),
      apply: vi.fn(),
      save: vi.fn(),
      restoreWorkingCopy: async () => {
        loads++
        handle.setHydrated('b'.repeat(64))
      },
    })
    handle.setHydrated('a'.repeat(64))
    for (let attempt = 1; attempt <= 4; attempt++) {
      for (const listener of frames)
        listener({
          type: 'recovery:required',
          documentId: 'pdf-1',
          code: 'REVISION_CONFLICT',
          message: 'Head changed',
        })
      await vi.waitFor(() => expect(bootstraps).toBe(Math.min(attempt, 3)))
      if (attempt < 4) await vi.waitFor(() => expect(loads).toBe(attempt))
    }
    expect(handle.reloadError).toMatch(/recovery|refresh/i)
    expect(handle.hydrated).toBe(false)
    handle.dispose()
  })
  it('gates registration on hydration and saves a recovered empty pending snapshot through promotion', async () => {
    const sent: any[] = []
    const client = {
      state: 'ready',
      clientId: 'client-1',
      connect() {},
      close() {},
      send(frame: unknown) {
        sent.push(frame)
      },
      onFrame() {
        return () => {}
      },
      onState() {
        return () => {}
      },
    }
    const workingCopy = {
      documentEpoch: 'epoch',
      workingRevision: 5,
      savedRevision: 4,
      sourceContentId: 'a'.repeat(64),
      checkpointId: 'checkpoint',
      dirty: true,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    }
    const calls: string[] = []
    const fetcher: typeof fetch = async (url, init) => {
      calls.push(String(url))
      if (String(url).endsWith('/bootstrap'))
        return Response.json({
          ...bootstrap,
          revision: 5,
          workingCopy: { ...workingCopy, savedRevision: 5, dirty: false },
        })
      if (String(url).endsWith('/manual-save-uploads'))
        return Response.json({
          uploadId: 'upload',
          operationId: 'manual-save',
          requestFingerprint: 'f'.repeat(64),
        })
      if (init?.method === 'PUT')
        return Response.json({ partId: 'manifest', sha256: 'a'.repeat(64), byteLength: 10 })
      return Response.json({
        persistence: {
          documentEpoch: 'epoch',
          operationId: 'manual-save',
          requestFingerprint: 'f'.repeat(64),
          checkpointId: 'checkpoint',
          blobHash: 'a'.repeat(64),
          workingRevision: 5,
          savedRevision: 5,
          dirty: false,
        },
      })
    }
    const handle = installPdfBrowserHostApi(
      { ...bootstrap, revision: 5, workingCopy },
      { client: client as never, target: {}, fetch: fetcher },
    )
    expect(sent).toHaveLength(0)
    expect(handle.recoveryDirty).toBe(true)
    handle.setHydrated(workingCopy.sourceContentId)
    expect(sent[0]).toMatchObject({
      type: 'editor:register',
      sourceContentId: workingCopy.sourceContentId,
      restoredCheckpointId: 'checkpoint',
    })
    expect(
      await handle.pdfApi.save({
        path: 'nexusdesk://pdf-1',
        markups: [],
        drawings: [],
        formValues: [],
        stamps: [],
      }),
    ).toMatchObject({ ok: true })
    expect(calls.some((url) => url.endsWith('/manual-save-uploads'))).toBe(true)
    expect(calls.some((url) => url.endsWith('/save'))).toBe(false)
    expect(handle.recoveryDirty).toBe(true)
    handle.setHydrated(workingCopy.sourceContentId)
    expect(handle.recoveryDirty).toBe(false)
    handle.dispose()
  })
  it('does not register an old loaded PDF while a new bootstrap is still loading', async () => {
    const sent: unknown[] = []
    const client = {
      state: 'ready',
      clientId: 'client',
      connect() {},
      close() {},
      send(frame: unknown) {
        sent.push(frame)
      },
      onFrame() {
        return () => {}
      },
      onState() {
        return () => {}
      },
    }
    const workingCopy = {
      documentEpoch: 'epoch',
      workingRevision: 4,
      savedRevision: 4,
      sourceContentId: 'a'.repeat(64),
      checkpointId: null,
      dirty: false,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    }
    let finish!: (response: Response) => void
    const handle = installPdfBrowserHostApi(
      { ...bootstrap, workingCopy },
      {
        client: client as never,
        target: {},
        fetch: async () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      },
    )
    handle.setHydrated(workingCopy.sourceContentId)
    const rebase = handle.rebase()
    handle.setHydrated(workingCopy.sourceContentId)
    expect(sent).toHaveLength(1)
    finish(
      Response.json({
        ...bootstrap,
        workingCopy: { ...workingCopy, sourceContentId: 'b'.repeat(64) },
      }),
    )
    await rebase
    handle.setHydrated(workingCopy.sourceContentId)
    expect(sent).toHaveLength(1)
    handle.setHydrated('b'.repeat(64))
    expect(sent).toHaveLength(2)
    handle.dispose()
  })
  it('keeps the editor busy until the Host confirms the hydrated source', () => {
    const sent: any[] = []
    const frames = new Set<(frame: any) => void>()
    const client = {
      state: 'ready',
      clientId: 'client',
      connect() {},
      close() {},
      send(frame: unknown) {
        sent.push(frame)
      },
      onFrame(listener: (frame: any) => void) {
        frames.add(listener)
        return () => frames.delete(listener)
      },
      onState() {
        return () => {}
      },
    }
    const workingCopy = {
      documentEpoch: 'epoch',
      workingRevision: 4,
      savedRevision: 4,
      sourceContentId: 'a'.repeat(64),
      checkpointId: null,
      dirty: false,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    }
    const handle = installPdfBrowserHostApi(
      { ...bootstrap, workingCopy },
      { client: client as never, target: {} },
    )
    handle.attachEditor({
      snapshot: vi.fn(),
      read: vi.fn(),
      propose: vi.fn(),
      proposeSave: vi.fn(),
      apply: vi.fn(),
      save: vi.fn(),
    })
    handle.setHydrated(workingCopy.sourceContentId)
    expect(handle.busy).toBe(true)
    for (const listener of frames)
      listener({
        type: 'editor:registered',
        id: sent[0].id,
        documentId: 'pdf-1',
        documentEpoch: 'epoch',
        sourceContentId: workingCopy.sourceContentId,
        revision: 4,
      })
    expect(handle.busy).toBe(false)
    handle.dispose()
  })
  it('reads PDF bytes and image references from the same immutable source after recovery', async () => {
    const workingCopy = {
      documentEpoch: 'epoch',
      workingRevision: 5,
      savedRevision: 4,
      sourceContentId: 'a'.repeat(64),
      checkpointId: 'checkpoint',
      dirty: true,
      recoveryState: 'ready' as const,
      contentUrl: '/api/documents/pdf-1/sources/' + 'a'.repeat(64) + '/content',
    }
    const calls: [string, RequestInit | undefined][] = []
    const transport = createHttpPdfBrowserTransport(
      { ...bootstrap, workingCopy },
      async (url, init) => {
        calls.push([String(url), init])
        if (String(url).endsWith('/content')) return new Response(Uint8Array.from([1, 2]))
        return Response.json(
          String(url).endsWith('list-page-images') ? { images: [] } : { png: null },
        )
      },
    )
    await transport.readContent()
    await transport.listPageImages()
    await transport.pageImagePng({ pageIndex: 0, rect: [0, 0, 10, 10] })
    expect(calls[0]?.[0]).toBe(workingCopy.contentUrl)
    expect(JSON.parse(calls[1]?.[1]?.body as string)).toEqual({ sourceContentId: 'a'.repeat(64) })
    expect(JSON.parse(calls[2]?.[1]?.body as string)).toMatchObject({
      sourceContentId: 'a'.repeat(64),
    })
  })
  it('rejects oversized save envelopes before HTTP dispatch', async () => {
    const fetcher = vi.fn()
    const transport = createHttpPdfBrowserTransport(bootstrap, fetcher)
    await expect(
      transport.save(
        {
          path: 'nexusdesk://pdf-1',
          markups: [],
          drawings: [],
          formValues: [],
          stamps: [],
          imageEdits: [
            {
              kind: 'insertImage',
              pageIndex: 0,
              image: 'A'.repeat(PDF_WEB_IMAGE_BASE64_LIMIT + 4),
              rect: [0, 0, 20, 20],
              layer: 'aboveText',
            },
          ],
        },
        4,
      ),
    ).rejects.toMatchObject({ code: 'PDF_PAYLOAD_TOO_LARGE' })
    expect(fetcher).not.toHaveBeenCalled()
  })
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
