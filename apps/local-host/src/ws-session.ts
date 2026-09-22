import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  parseClientFrame,
  PROTOCOL_VERSION,
  type AgentServerFrame,
  type ClientFrame,
  type ClientId,
  type DocumentId,
} from '@nexusdesk/protocol'
import { WebSocket, WebSocketServer } from 'ws'

import { acceptWebSocketOrigin } from './origin-policy'
import { DocumentRegistry, type AuthorizedDocument } from './document-registry'
import type { WorkingCopyCoordinator } from './working-copy-coordinator'
import { WorkingCopyCoordinatorError } from './working-copy-coordinator'

const MAX_FRAME_BYTES = 1024 * 1024

export interface WsSessionOptions {
  origin: () => string
  hasSession(sessionId: string): boolean
  documents: DocumentRegistry
  authorizedDocument(documentId: DocumentId): AuthorizedDocument | undefined
  workingCopy?: WorkingCopyCoordinator
  onFrame?: (frame: ClientFrame, clientId: ClientId) => void | Promise<void>
  onDisconnect?: (clientId: ClientId) => void
}

export interface WsSessionServer {
  assertSession(clientId: string, sessionId: string): void
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
  const clientSessions = new Map<string, string>()
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

  wss.on('connection', (socket, request) => {
    const clientId = randomUUID() as ClientId
    clients.set(clientId, socket)
    clientSessions.set(clientId, sessionCookie(request)!)
    let queue = Promise.resolve()
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
      let frame: ClientFrame
      try { frame = parseClientFrame(JSON.parse(data.toString())) } catch {
        socket.close(1008, 'invalid client frame')
        return
      }
      queue = queue.then(async () => {
        switch (frame.type) {
          case 'editor:register': {
            if (frame.clientId !== clientId) throw new Error('client identity mismatch')
            if (options.workingCopy?.enabled(frame.documentId)) {
              await options.workingCopy.register(frame, clientSessions.get(clientId)!)
              socket.send(JSON.stringify({ type: 'editor:registered', protocolVersion: 1, id: frame.id,
                documentId: frame.documentId, revision: frame.revision, documentEpoch: frame.documentEpoch,
                sourceContentId: frame.sourceContentId }))
              break
            }
            const authorized = options.authorizedDocument(frame.documentId)
            if (authorized !== undefined) {
              options.documents.refreshFromHost(authorized, frame.rendererInstanceId)
            }
            options.documents.register(frame)
            socket.send(JSON.stringify({ type: 'editor:attached', protocolVersion: 1,
              id: frame.id, documentId: frame.documentId, revision: frame.revision }))
            break
          }
          case 'editor:revision':
            if (frame.clientId !== clientId) throw new Error('client identity mismatch')
            if (options.workingCopy?.enabled(frame.documentId)) {
              throw new WorkingCopyCoordinatorError('DURABLE_REVISION_REQUIRED', 'Only a durable checkpoint can advance this document revision.')
            }
            options.documents.commitRevision(frame)
            break
          case 'editor:detach':
            if (frame.clientId !== clientId) throw new Error('client identity mismatch')
            if (options.workingCopy?.enabled(frame.documentId)) await options.workingCopy.detach(frame.documentId, clientId)
            else options.documents.detach(frame)
            break
          case 'editor:result':
            if (frame.target.clientId !== clientId) throw new Error('client identity mismatch')
            break
          default:
            break
        }
        await options.onFrame?.(frame, clientId)
      }).catch((error: unknown) => {
        const documentId = 'documentId' in frame ? frame.documentId : frame.type === 'editor:result' ? frame.target.documentId : undefined
        let durable = false
        try { durable = documentId !== undefined && options.workingCopy?.enabled(documentId) === true } catch { /* Unknown document. */ }
        if (durable) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'recovery:required', protocolVersion: 1,
            id: frame.id, documentId, code: (error as { code?: string })?.code ?? 'WORKING_COPY_RECOVERY_REQUIRED',
            message: error instanceof Error ? error.message : 'Working-copy recovery is required.' }))
        } else socket.close(1008, 'invalid client frame')
      })
    })
    socket.once('close', () => {
      clients.delete(clientId)
      clientSessions.delete(clientId)
      void queue.then(() => options.workingCopy?.disconnect(clientId)).finally(() => {
        options.documents.detachClient(clientId)
        options.onDisconnect?.(clientId)
      }).catch(() => undefined)
    })
  })

  return {
    assertSession(clientId, sessionId) {
      if (clientSessions.get(clientId) !== sessionId || clients.get(clientId as ClientId)?.readyState !== WebSocket.OPEN) {
        throw new WorkingCopyCoordinatorError('FILE_NOT_AUTHORIZED', 'HTTP request must use its own authenticated websocket client.')
      }
    },
    send(clientId, frame) {
      const client = clients.get(clientId)
      if (client?.readyState !== WebSocket.OPEN)
        throw new Error(`client ${clientId} is disconnected`)
      client.send(JSON.stringify(frame))
    },
    broadcastShellChanged() {
      shellSequence += 1
      const frame = JSON.stringify({
        type: 'shell:changed',
        protocolVersion: PROTOCOL_VERSION,
        sequence: shellSequence,
      })
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
