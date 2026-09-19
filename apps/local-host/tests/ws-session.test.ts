import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { PROTOCOL_VERSION } from '@nexusdesk/protocol'
import { startLocalHost, type RunningLocalHost } from '../src/server'

let running: RunningLocalHost | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

async function sessionCookie(host: RunningLocalHost): Promise<string> {
  const response = await fetch(host.bootstrapUrl, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null) throw new Error('bootstrap did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

function wsUrl(origin: string): string {
  return `${origin.replace('http:', 'ws:')}/ws`
}

describe('authenticated WebSocket session', () => {
  it('sends server readiness only to an authenticated same-origin client', async () => {
    running = await startLocalHost()
    const cookie = await sessionCookie(running)
    const socket = new WebSocket(wsUrl(running.origin), {
      headers: { Cookie: cookie, Origin: running.origin },
    })

    const frame = await new Promise<unknown>((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString())))
      socket.once('error', reject)
    })
    expect(frame).toMatchObject({ type: 'server:ready', protocolVersion: PROTOCOL_VERSION })
    socket.close()
  })

  it('rejects a malicious Origin before sending document-capable frames', async () => {
    running = await startLocalHost()
    const cookie = await sessionCookie(running)
    const received: unknown[] = []
    const socket = new WebSocket(wsUrl(running.origin), {
      headers: { Cookie: cookie, Origin: 'https://evil.example' },
    })
    socket.on('message', (data) => received.push(JSON.parse(data.toString())))

    const outcome = await new Promise<'error' | 'open'>((resolve) => {
      socket.once('unexpected-response', () => resolve('error'))
      socket.once('error', () => resolve('error'))
      socket.once('open', () => resolve('open'))
    })
    expect(outcome).toBe('error')
    expect(received).toEqual([])
    socket.terminate()
  })

  it('closes invalid client frames with policy code 1008', async () => {
    running = await startLocalHost()
    const cookie = await sessionCookie(running)
    const socket = new WebSocket(wsUrl(running.origin), {
      headers: { Cookie: cookie, Origin: running.origin },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    socket.send('{not-json')

    const code = await new Promise<number>((resolve) => socket.once('close', resolve))
    expect(code).toBe(1008)
  })
})
