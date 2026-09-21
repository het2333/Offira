import { expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { WebSocket } from 'ws'
import { startLocalHost } from '../src/server'

it('serves authenticated official Office boot and RPC through the real runtime', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const running = await startLocalHost({
    documents: [{ documentId: 'native-smoke-doc', title: 'Native smoke', editorType: 'sheets', revision: 0 }],
    runtimeCommand: { entry: resolve(root, 'packages/nexusdesk-runtime-host/lib/index.mjs'), args: [root, resolve(root, 'packages/nexusdesk-runtime-host/profile'), 'runtime'] },
  })
  let socket: WebSocket | undefined
  try {
    expect((await fetch(running.origin + '/harness/index.html')).status).toBe(401)
    const launch = await fetch(running.bootstrapUrl, { redirect: 'manual' })
    const cookie = launch.headers.get('set-cookie')!.split(';')[0]!
    const headers = { Cookie: cookie }
    expect((await fetch(running.origin + '/harness/index.html', { headers })).status).toBe(403)
    socket = new WebSocket(running.origin.replace('http:', 'ws:') + '/ws', { headers: { ...headers, Origin: running.origin } })
    const frames: any[] = []
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())))
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'server:ready')).toBe(true), { timeout: 10000 })
    const clientId = frames.find((frame) => frame.type === 'server:ready').clientId
    const send = (frame: object) => socket!.send(JSON.stringify({ protocolVersion: 1, documentId: 'native-smoke-doc', ...frame }))
    send({ type: 'editor:register', id: 'register', clientId, rendererInstanceId: 'renderer-smoke', editorType: 'sheets', revision: 0 })
    send({ type: 'harness:bind', id: 'bind' })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'harness:bound')).toBe(true), { timeout: 10000 })
    const index = await fetch(`${running.origin}/harness/index.html?clientId=${clientId}&documentId=native-smoke-doc`, { headers })
    expect(index.status).toBe(200)
    const html = await index.text()
    expect(html).toContain('installOfficePanelBinding')
    const plugin = html.match(/<script[^>]+src="(\/plugins\/[^"<>]+)"/)
    expect(plugin).not.toBeNull()
    const bundle = await fetch(running.origin + plugin![1]!.replaceAll('&amp;', '&'), { headers })
    expect(bundle.status).toBe(200)
    expect(await bundle.text()).toContain('__ModuleLoader__')
    send({ type: 'harness:rpc', id: 'catalog', endpoint: 'session/modelCatalog', payload: { args: {} } })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'harness:result' && frame.id === 'catalog')).toBe(true), { timeout: 10000 })
    expect(frames.find((frame) => frame.id === 'catalog').result.ok).toBe(true)
    send({ type: 'harness:rpc', id: 'foreign', endpoint: 'session/cancel', payload: { args: { request: { sessionId: 'foreign-session' } } } })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'harness:error' && frame.id === 'foreign')).toBe(true))
  } finally {
    socket?.close()
    await running.close()
  }
}, 45000)
