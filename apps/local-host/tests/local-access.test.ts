import { afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startLocalHost, type RunningLocalHost } from '../src/server'

let running: RunningLocalHost | undefined
afterEach(async () => { await running?.close(); running = undefined })

it('opens local mode without a bootstrap token and connects the browser session', async () => {
  running = await startLocalHost({ localAccess: true })
  expect(running.bootstrapUrl).toBe(running.origin + '/')
  const response = await fetch(running.origin + '/api/bootstrap')
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!
  const ws = new WebSocket(running.origin.replace('http:', 'ws:') + '/ws', {
    headers: { Cookie: cookie, Origin: running.origin },
  })
  try {
    const frame = await new Promise<any>((resolve, reject) => {
      ws.once('message', data => resolve(JSON.parse(String(data))))
      ws.once('error', reject)
    })
    expect(frame.type).toBe('server:ready')
    expect((await fetch(running.origin + '/api/bootstrap', {
      headers: { Origin: 'https://untrusted.example' },
    })).status).toBe(421)
  } finally { ws.close() }
})

it('restores an existing local browser cookie after a Host restart without a page reload', async () => {
  running = await startLocalHost({ localAccess: true })
  const response = await fetch(running.origin + '/api/bootstrap')
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!
  await running.close()
  running = await startLocalHost({ localAccess: true })
  const ws = new WebSocket(running.origin.replace('http:', 'ws:') + '/ws', {
    headers: { Cookie: cookie, Origin: running.origin },
  })
  try {
    const frame = await new Promise<any>((resolve, reject) => {
      ws.once('message', data => resolve(JSON.parse(String(data))))
      ws.once('error', reject)
    })
    expect(frame.type).toBe('server:ready')
  } finally { ws.close() }
})
