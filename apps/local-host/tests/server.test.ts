import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

import { PROTOCOL_VERSION } from '@nexusdesk/protocol'
import { DocumentDriverRegistry, type LocalDocumentDriver } from '../src/document-driver'
import { startLocalHost, type RunningLocalHost } from '../src/server'
import { createWorkingCopyStore } from '../src/working-copy-store'

let running: RunningLocalHost | undefined
let temporaryDirectory: string | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
  if (temporaryDirectory !== undefined)
    await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

async function authenticatedHeaders(): Promise<{ cookie: string }> {
  const response = await fetch(running!.bootstrapUrl, { redirect: 'manual' })
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]! }
}

describe('startLocalHost HTTP bootstrap', () => {
  it('authenticates binary uploads against the websocket owner and publishes a durable lookup before acknowledging apply', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'server-checkpoint-'))
    const path = join(temporaryDirectory, 'source.xlsx')
    await writeFile(path, 'original')
    const store = await createWorkingCopyStore({ rootDirectory: join(temporaryDirectory, 'recovery'),
      authorizedPath: path, documentId: 'sheet', editorType: 'sheets' })
    const driver: LocalDocumentDriver = { document: { documentId: 'sheet', editorType: 'sheets', title: 'Sheet', revision: 1 },
      bootstrap: async () => ({ kind: 'sheets' }), execute: async () => ({}), close: async () => {},
      workingCopy: { store, acquireSource: () => store.acquireSource(), readSource: (id) => store.readSource(id),
        materialize: async ({ parts }) => parts.get('document')! } }
    let unsafeWrites = 0
    driver.writeContent = async () => { unsafeWrites++; throw Error('Unsafe content write reached driver') }
    driver.execute = async () => { unsafeWrites++; return {} }
    running = await startLocalHost({ documentDrivers: new DocumentDriverRegistry([driver]),
      runtimeCommand: { entry: fileURLToPath(new URL('./fixtures/fake-runtime.mjs', import.meta.url)) } })
    const headers = await authenticatedHeaders()
    const bootstrap = await (await fetch(running.origin + '/api/documents/sheet/bootstrap', { headers })).json()
    expect(bootstrap.workingCopy).toMatchObject({ workingRevision: 1, dirty: false, contentUrl: expect.stringContaining('/sources/') })
    const source = await fetch(bootstrap.workingCopy.contentUrl, { headers })
    expect(await source.text()).toBe('original')
    const socket = new WebSocket(running.origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: headers.cookie, Origin: running.origin } })
    const frames: any[] = []
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())))
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'server:ready')).toBe(true))
    const clientId = frames.find((frame) => frame.type === 'server:ready').clientId
    const send = (frame: object) => socket.send(JSON.stringify({ protocolVersion: 1, ...frame }))
    send({ type: 'editor:register', id: 'register', clientId, documentId: 'sheet', editorType: 'sheets',
      rendererInstanceId: 'renderer', revision: 1, documentEpoch: bootstrap.workingCopy.documentEpoch,
      sourceContentId: bootstrap.workingCopy.sourceContentId, restoredCheckpointId: null })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'editor:registered')).toBe(true))
    send({ type: 'agent:start', id: 'start', sessionId: 'turn', documentId: 'sheet', prompt: 'editor-wait' })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'approval:request')).toBe(true))
    send({ type: 'approval:response', id: 'editor-approval-1', outcome: 'allowed-once' })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'editor:request')).toBe(true))
    const frame = frames.find((frame) => frame.type === 'editor:request')
    const result = { ok: true, summary: 'Applied', warnings: [] }
    const metadata = { schemaVersion: 1, requestId: frame.id, clientId, documentEpoch: bootstrap.workingCopy.documentEpoch,
      operationId: frame.target.operationId, expectedWorkingRevision: 1, expectedSavedRevision: 1,
      sourceContentId: bootstrap.workingCopy.sourceContentId, planHash: frame.approval.planHash,
      result, payloadKind: 'xlsx-save-plan' }
    const base = running.origin + '/api/documents/sheet/checkpoint-uploads'
    const jsonHeaders = { ...headers, 'Content-Type': 'application/json', 'X-NexusDesk-Client-Id': clientId }
    const wrong = await fetch(base, { method: 'POST', headers: { ...jsonHeaders, 'X-NexusDesk-Client-Id': 'other' }, body: JSON.stringify(metadata) })
    expect(wrong.status).toBe(403)
    const created = await (await fetch(base, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(metadata) })).json()
    expect(created.requestFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const raw = new Uint8Array(2_000_001).fill(65)
    const part = await (await fetch(base + '/' + created.uploadId + '/parts/document', { method: 'PUT',
      headers: { ...jsonHeaders, 'Content-Type': 'application/octet-stream' }, body: raw })).json()
    const commit = await fetch(base + '/' + created.uploadId + '/commit', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ parts: [part] }) })
    expect(commit.status).toBe(200)
    const terminal = await commit.json()
    expect(terminal.persistence).toMatchObject({ dirty: true, workingRevision: 2 })
    expect(await readFile(path, 'utf8')).toBe('original')
    const lookup = await fetch(running.origin + '/api/documents/sheet/operations/lookup', { method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ documentEpoch: bootstrap.workingCopy.documentEpoch, operationId: frame.target.operationId, requestFingerprint: created.requestFingerprint }) })
    expect(await lookup.json()).toMatchObject({ state: 'committed', persistence: terminal.persistence })
    send({ type: 'editor:result', id: frame.id, target: frame.target, result, persistence: terminal.persistence })
    await vi.waitFor(() => expect(frames.some((value) => value.event?.type === 'test/editor-result')).toBe(true))
    send({ type: 'editor:revision', id: 'volatile', clientId, documentId: 'sheet', revision: 3 })
    await vi.waitFor(() => expect(frames.some((value) => value.type === 'recovery:required')).toBe(true))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    const unsafe = await fetch(running.origin + '/api/documents/sheet/content', { method: 'PUT',
      headers: { ...jsonHeaders, 'Content-Type': 'application/octet-stream', 'If-Match': '2' }, body: 'bypass' })
    expect(unsafe.status).toBe(409)
    const unsafeAction = await fetch(running.origin + '/api/documents/sheet/save-workbook', { method: 'POST', headers: jsonHeaders, body: '{}' })
    expect(unsafeAction.status).toBe(409)
    expect(unsafeWrites).toBe(0)
    socket.close()
  })

  it('exchanges the launch token once and redirects without it', async () => {
    running = await startLocalHost()

    const first = await fetch(running.bootstrapUrl, { redirect: 'manual' })
    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toBe('/')
    expect(first.headers.get('set-cookie')).toMatch(
      /^nexusdesk_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/,
    )

    const replay = await fetch(running.bootstrapUrl, { redirect: 'manual' })
    expect(replay.status).toBe(401)
  })

  it('wires an explicitly injected runtime through the authenticated browser session', async () => {
    const runtimeEntry = fileURLToPath(new URL('./fixtures/fake-runtime.mjs', import.meta.url))
    running = await startLocalHost({
      runtimeCommand: { entry: runtimeEntry },
      documents: [{
        documentId: 'document-1',
        title: 'Forecast.xlsx',
        editorType: 'sheets',
        revision: 1,
      }],
    })
    const headers = await authenticatedHeaders()
    const socket = new WebSocket(running.origin.replace(/^http/, 'ws') + '/ws', {
      headers: { Cookie: headers.cookie, Origin: running.origin },
    })
    const frames: Array<Record<string, unknown>> = []
    socket.on('message', (data) =>
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>),
    )
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'server:ready')).toBe(true))
    const clientId = frames.find((frame) => frame.type === 'server:ready')!.clientId as string
    socket.send(
      JSON.stringify({
        type: 'editor:register',
        protocolVersion: 1,
        id: 'register-1',
        clientId,
        rendererInstanceId: 'renderer-1',
        documentId: 'document-1',
        editorType: 'sheets',
        revision: 1,
      }),
    )
    socket.send(
      JSON.stringify({
        type: 'agent:start',
        protocolVersion: 1,
        id: 'start-1',
        sessionId: 'session-1',
        documentId: 'document-1',
        prompt: 'hello',
      }),
    )

    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'agent:event')).toBe(true))
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: 'agent:event',
        event: expect.objectContaining({ type: 'stream/chunk' }),
      }),
    )
    socket.close()
  })

  it('keeps the health response free of document and session data', async () => {
    running = await startLocalHost()

    const response = await fetch(`${running.origin}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION })
  })

  it('returns authenticated document summaries without filesystem paths', async () => {
    running = await startLocalHost({
      documents: [
        {
          documentId: 'document-1',
          title: 'Forecast.xlsx',
          editorType: 'sheets',
          revision: 3,
          path: '/Users/example/secret/Forecast.xlsx',
        },
      ],
    })
    const headers = await authenticatedHeaders()

    const response = await fetch(`${running.origin}/api/bootstrap`, { headers })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      documents: [
        { documentId: 'document-1', title: 'Forecast.xlsx', editorType: 'sheets', revision: 3 },
      ],
    })
  })

  it('routes document bootstrap and actions through the owning driver', async () => {
    const actions: Array<[string, unknown]> = []
    const driver: LocalDocumentDriver = {
      document: {
        documentId: 'doc-1',
        title: 'Report.docx',
        editorType: 'docs',
        revision: 4,
      },
      async bootstrap(origin) {
        return { documentId: 'doc-1', kind: 'docs', origin }
      },
      async execute(action, payload) {
        actions.push([action, payload])
        return { ok: true }
      },
      async close() {},
    }
    running = await startLocalHost({
      documentDrivers: new DocumentDriverRegistry([driver]),
    })
    const headers = { ...(await authenticatedHeaders()), 'Content-Type': 'application/json' }

    const bootstrap = await fetch(`${running.origin}/api/documents/doc-1/bootstrap`, { headers })
    const action = await fetch(`${running.origin}/api/documents/doc-1/read-document`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ scope: 'document' }),
    })
    const unknown = await fetch(`${running.origin}/api/documents/missing/bootstrap`, { headers })

    expect(await bootstrap.json()).toMatchObject({ documentId: 'doc-1', kind: 'docs' })
    expect(action.status).toBe(200)
    expect(actions).toEqual([['read-document', { scope: 'document' }]])
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' })
  })

  it('serves authenticated Shell state and validates tab and file mutations', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'nexusdesk-shell-api-'))
    running = await startLocalHost({
      shellStatePath: join(temporaryDirectory, 'shell.json'),
      documents: [
        {
          documentId: 'document-1',
          title: 'Forecast.xlsx',
          editorType: 'sheets',
          revision: 3,
          path: '/Users/example/authorized/Forecast.xlsx',
        },
      ],
    })
    const headers = { ...(await authenticatedHeaders()), 'Content-Type': 'application/json' }

    const bootstrap = await fetch(`${running.origin}/api/shell/bootstrap`, { headers })
    const activated = await fetch(`${running.origin}/api/shell/tabs/activate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: 'document:document-1' }),
    })
    const unauthorized = await fetch(`${running.origin}/api/shell/files/open`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fileId: 'not-authorized', path: '/etc/passwd' }),
    })
    const wrongMethod = await fetch(`${running.origin}/api/shell/tabs/activate`, { headers })

    expect(bootstrap.status).toBe(200)
    expect(await bootstrap.json()).toMatchObject({
      tabs: [
        expect.objectContaining({ id: 'home' }),
        expect.objectContaining({ documentId: 'document-1' }),
      ],
    })
    expect(activated.status).toBe(200)
    expect(await activated.json()).toMatchObject({
      tabs: expect.arrayContaining([
        expect.objectContaining({ id: 'document:document-1', active: true }),
      ]),
    })
    expect(unauthorized.status).toBe(403)
    expect(await unauthorized.json()).toMatchObject({ code: 'FILE_NOT_AUTHORIZED' })
    expect(wrongMethod.status).toBe(405)
    expect(await wrongMethod.json()).toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('serves hashed assets immutably and falls client routes back to no-store shell HTML', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'nexusdesk-web-'))
    const webRoot = join(temporaryDirectory, 'web')
    const docsRoot = join(temporaryDirectory, 'docs')
    const sheetsRoot = join(temporaryDirectory, 'sheets')
    const slidesRoot = join(temporaryDirectory, 'slides')
    await mkdir(join(webRoot, 'assets'), { recursive: true })
    await mkdir(docsRoot, { recursive: true })
    await mkdir(sheetsRoot, { recursive: true })
    await mkdir(slidesRoot, { recursive: true })
    await writeFile(join(webRoot, 'index.html'), '<div id="root">shell</div>')
    await writeFile(join(webRoot, 'assets', 'index-a1b2c3.js'), 'globalThis.shellLoaded=true')
    await writeFile(join(docsRoot, 'index.html'), '<div id="root">docs</div>')
    await writeFile(join(sheetsRoot, 'index.html'), '<div id="root">sheets</div>')
    await writeFile(join(slidesRoot, 'index.html'), '<div id="root">slides</div>')
    running = await startLocalHost({
      staticAssets: { webRoot, editorRoots: { docs: docsRoot, sheets: sheetsRoot, slides: slidesRoot } },
    })
    const headers = await authenticatedHeaders()

    const asset = await fetch(`${running.origin}/assets/index-a1b2c3.js`, { headers })
    const route = await fetch(`${running.origin}/sheets/?host=local-web&documentId=document-1`, {
      headers,
    })
    const docsRoute = await fetch(`${running.origin}/docs/?host=local-web&documentId=doc-1`, {
      headers,
    })
    const slidesRoute = await fetch(`${running.origin}/slides/?host=local-web&documentId=slides-1`, { headers })
    const unknownApi = await fetch(`${running.origin}/api/unknown`, { headers })

    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(route.headers.get('cache-control')).toBe('no-store')
    expect(await route.text()).toContain('sheets')
    expect(await docsRoute.text()).toContain('docs')
    expect(await slidesRoute.text()).toContain('slides')
    expect(unknownApi.status).toBe(404)
    expect(unknownApi.headers.get('content-type')).toContain('application/json')
  })
})
