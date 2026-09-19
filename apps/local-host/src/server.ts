import { createServer, type ServerResponse } from 'node:http'

import { PROTOCOL_VERSION } from '@nexusdesk/protocol'

import { createBootstrapAuth } from './bootstrap-auth'
import type { AgentRouter } from './agent-router'
import { DocumentRegistry } from './document-registry'
import { acceptHttpOrigin } from './origin-policy'
import { installWsSessionServer } from './ws-session'

export interface RunningLocalHost {
  readonly origin: string
  readonly bootstrapUrl: string
  close(): Promise<void>
}

export interface StartLocalHostOptions {
  documentRegistry?: DocumentRegistry
  agentRouter?: AgentRouter
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function cookieSession(cookie: string | undefined): string | undefined {
  if (cookie === undefined) return undefined
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === 'nexusdesk_session') return value.join('=') || undefined
  }
  return undefined
}

/** Start one authenticated, loopback-only NexusDesk host. */
export async function startLocalHost(options: StartLocalHostOptions = {}): Promise<RunningLocalHost> {
  const auth = createBootstrapAuth()
  const sessions = new Set<string>()
  const documents = options.documentRegistry ?? new DocumentRegistry()
  let origin = ''
  let closing: Promise<void> | undefined

  const server = createServer((request, response) => {
    if (!acceptHttpOrigin(request, origin)) {
      sendJson(response, 421, { error: 'invalid local host authority' })
      return
    }
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname === '/health') {
      sendJson(response, 200, { ok: true, protocolVersion: PROTOCOL_VERSION })
      return
    }
    if (url.pathname === '/bootstrap') {
      const exchanged = auth.exchange(url.searchParams.get('token') ?? '')
      if (!exchanged.ok) {
        sendJson(response, 401, { error: 'invalid or expired bootstrap token' })
        return
      }
      sessions.add(exchanged.sessionId)
      response.writeHead(303, {
        Location: '/',
        'Set-Cookie': exchanged.cookie,
        'Cache-Control': 'no-store',
      })
      response.end()
      return
    }
    const sessionId = cookieSession(request.headers.cookie)
    if (sessionId === undefined || !sessions.has(sessionId)) {
      sendJson(response, 401, { error: 'authentication required' })
      return
    }
    if (url.pathname === '/') {
      const body = '<!doctype html><title>NexusDesk</title><div id="root"></div>'
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      })
      response.end(body)
      return
    }
    sendJson(response, 404, { error: 'not found' })
  })

  const wsSessions = installWsSessionServer(server, {
    origin: () => origin,
    hasSession: (sessionId) => sessions.has(sessionId),
    documents,
    onFrame: (frame, clientId) => options.agentRouter?.handleClientFrame(frame, clientId),
    onDisconnect: (clientId) => options.agentRouter?.disconnectClient(clientId),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('local host did not bind a TCP port')
  }
  origin = `http://127.0.0.1:${String(address.port)}`

  return {
    origin,
    bootstrapUrl: `${origin}/bootstrap?token=${encodeURIComponent(auth.token)}`,
    close: () => (closing ??= (async () => {
      await wsSessions.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
      sessions.clear()
    })()),
  }
}
