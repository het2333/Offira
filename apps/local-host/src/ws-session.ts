import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  parseClientFrame,
  PROTOCOL_VERSION,
  type AgentServerFrame,
  type ClientFrame,
  type ClientId,
} from '@nexusdesk/protocol'
import { WebSocket, WebSocketServer } from 'ws'

import { acceptWebSocketOrigin } from './origin-policy'
import { DocumentRegistry } from './document-registry'

const MAX_FRAME_BYTES = 1024 * 1024

export interface WsSessionOptions {
  origin: () => string
  hasSession(sessionId: string): boolean
  documents: DocumentRegistry
  onFrame?: (frame: ClientFrame, clientId: ClientId) => void
  onDisconnect?: (clientId: ClientId) => void
}

export interface WsSessionServer {
  send(clientId: ClientId, frame: AgentServerFrame): void
  broadcastShellChanged(): void
  close(): Promise<void>
}

function sessionCookie(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie
  if (cookie === undefined) return undefined
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === 'nexusdesk_session') return value.join('=') || undefined
  }
  return undefined
}

function rejectUpgrade(socket: Duplex, status: 401 | 403 | 404): void {
  const label = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'
  socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** Attach the authenticated NexusDesk WebSocket surface to an HTTP server. */
export function installWsSessionServer(
  server: HttpServer,
  options: WsSessionOptions,
): WsSessionServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const clients = new Map<ClientId, WebSocket>()
  let shellSequence = 0

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') {
      rejectUpgrade(socket, 404)
      return
    }
    const origin = options.origin()
    if (!acceptWebSocketOrigin(request, origin)) {
      rejectUpgrade(socket, 403)
      return
    }
    const sessionId = sessionCookie(request)
    if (sessionId === undefined || !options.hasSession(sessionId)) {
      rejectUpgrade(socket, 401)
      return
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit('connection', webSocket, request)
    })
  })

  wss.on('connection', (socket) => {
    const clientId = randomUUID() as ClientId
    clients.set(clientId, socket)
    socket.send(
      JSON.stringify({
        type: 'server:ready',
        protocolVersion: PROTOCOL_VERSION,
        clientId,
      }),
    )
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1008, 'binary frames are not supported')
        return
      }
      try {
        const frame = parseClientFrame(JSON.parse(data.toString()))
        switch (frame.type) {
          case 'editor:register':
            if (frame.clientId !== clientId) throw new Error('client identity mismatch')
            options.documents.register(frame)
            break
          case 'editor:revision':
            if (frame.clientId !== clientId) throw new Error('client identity mismatch')
            options.documents.commitRevision(frame)
            break
          case 'editor:detach':
            if (frame.clientId !== clientId) throw new Error('client identity mismatch')
            options.documents.detachClient(frame.clientId)
            break
          case 'editor:result':
            if (frame.target.clientId !== clientId) throw new Error('client identity mismatch')
            break
          default:
            break
        }
        options.onFrame?.(frame, clientId as ClientId)
      } catch {
        socket.close(1008, 'invalid client frame')
      }
    })
    socket.once('close', () => {
      clients.delete(clientId)
      options.documents.detachClient(clientId as ClientId)
      options.onDisconnect?.(clientId as ClientId)
    })
  })

  return {
    send(clientId, frame) {
      const client = clients.get(clientId)
      if (client?.readyState !== WebSocket.OPEN)
        throw new Error(`client ${clientId} is disconnected`)
      client.send(JSON.stringify(frame))
    },
    broadcastShellChanged() {
      shellSequence += 1
      const frame = JSON.stringify({ type: 'shell:changed', sequence: shellSequence })
      for (const client of clients.values()) {
        if (client.readyState === WebSocket.OPEN) client.send(frame)
      }
    },
    async close() {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close(1001, 'local host shutting down')
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
