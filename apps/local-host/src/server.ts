import { createServer, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { PROTOCOL_VERSION } from '@nexusdesk/protocol'

import { createBootstrapAuth } from './bootstrap-auth'
import type { AgentRouter } from './agent-router'
import { AgentRouter as OwnedAgentRouter } from './agent-router'
import { DocumentRegistry } from './document-registry'
import { HarnessSupervisor } from './harness-supervisor'
import { OperationStore } from './operation-store'
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
  documents?: LocalDocument[]
  staticAssets?: { webRoot: string; sheetsRoot: string }
  documentService?: {
    bootstrap(document: LocalDocument, origin: string): Promise<unknown>
    execute(document: LocalDocument, action: string, payload: unknown): Promise<unknown>
  }
  runtimeCommand?: { entry: string; args?: string[]; nodeExecutable?: string }
}

export interface LocalDocument {
  documentId: string
  title: string
  editorType: 'sheets'
  revision: number
  path?: string
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

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

async function staticFile(
  root: string,
  pathname: string,
): Promise<{ body: Buffer; type: string } | undefined> {
  const relative = pathname.replace(/^\/+/, '')
  const path = resolve(root, relative)
  const rootPrefix = `${resolve(root)}${sep}`
  if (path !== resolve(root) && !path.startsWith(rootPrefix)) return undefined
  try {
    return {
      body: await readFile(path),
      type: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    }
  } catch {
    return undefined
  }
}

function sendFile(
  response: ServerResponse,
  file: { body: Buffer; type: string },
  immutable: boolean,
): void {
  response.writeHead(200, {
    'Content-Type': file.type,
    'Content-Length': file.body.byteLength,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  })
  response.end(file.body)
}

async function readJsonBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > 2_000_000) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Start one authenticated, loopback-only NexusDesk host. */
export async function startLocalHost(
  options: StartLocalHostOptions = {},
): Promise<RunningLocalHost> {
  const auth = createBootstrapAuth()
  const sessions = new Set<string>()
  const documents = options.documentRegistry ?? new DocumentRegistry()
  const supervisor =
    options.runtimeCommand === undefined
      ? undefined
      : new HarnessSupervisor({
          entry: options.runtimeCommand.entry,
          ...(options.runtimeCommand.args === undefined
            ? {}
            : { args: options.runtimeCommand.args }),
          ...(options.runtimeCommand.nodeExecutable === undefined
            ? {}
            : { nodeExecutable: options.runtimeCommand.nodeExecutable }),
        })
  let wsSessions: ReturnType<typeof installWsSessionServer>
  const ownedRouter =
    options.agentRouter === undefined && supervisor !== undefined
      ? new OwnedAgentRouter({
          supervisor,
          documents,
          operations: new OperationStore(),
          sendToClient: (clientId, frame) => wsSessions.send(clientId, frame),
        })
      : undefined
  const agentRouter = options.agentRouter ?? ownedRouter
  let origin = ''
  let closing: Promise<void> | undefined

  const server = createServer((request, response) => {
    void (async () => {
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
      if (url.pathname === '/api/bootstrap') {
        sendJson(response, 200, {
          documents: (options.documents ?? []).map(
            ({ documentId, title, editorType, revision }) => ({
              documentId,
              title,
              editorType,
              revision,
            }),
          ),
        })
        return
      }
      const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/(bootstrap|[^/]+)$/)
      if (documentMatch !== null) {
        const documentId = decodeURIComponent(documentMatch[1]!)
        const action = documentMatch[2]!
        const document = (options.documents ?? []).find(
          (candidate) => candidate.documentId === documentId,
        )
        if (document === undefined || options.documentService === undefined) {
          sendJson(response, 404, { error: 'document service is unavailable' })
          return
        }
        try {
          const result =
            action === 'bootstrap'
              ? await options.documentService.bootstrap(document, origin)
              : await options.documentService.execute(document, action, await readJsonBody(request))
          sendJson(response, 200, result)
        } catch (error: unknown) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : 'document request failed',
          })
        }
        return
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'not found' })
        return
      }
      if (options.staticAssets !== undefined) {
        if (url.pathname === '/sheets' || url.pathname.startsWith('/sheets/')) {
          const relative = url.pathname.replace(/^\/sheets\/?/, '') || 'index.html'
          const file =
            (await staticFile(options.staticAssets.sheetsRoot, relative)) ??
            (await staticFile(options.staticAssets.sheetsRoot, 'index.html'))
          if (file !== undefined) {
            sendFile(response, file, relative !== 'index.html')
            return
          }
        } else {
          const relative = url.pathname.replace(/^\//, '') || 'index.html'
          const file = await staticFile(options.staticAssets.webRoot, relative)
          if (file !== undefined) {
            sendFile(response, file, relative !== 'index.html')
            return
          }
          const fallback = await staticFile(options.staticAssets.webRoot, 'index.html')
          if (fallback !== undefined) {
            sendFile(response, fallback, false)
            return
          }
        }
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
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : 'internal error',
        })
      } else {
        response.destroy()
      }
    })
  })

  wsSessions = installWsSessionServer(server, {
    origin: () => origin,
    hasSession: (sessionId) => sessions.has(sessionId),
    documents,
    onFrame: (frame, clientId) => agentRouter?.handleClientFrame(frame, clientId),
    onDisconnect: (clientId) => agentRouter?.disconnectClient(clientId),
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
  await supervisor?.ready()

  return {
    origin,
    bootstrapUrl: `${origin}/bootstrap?token=${encodeURIComponent(auth.token)}`,
    close: () =>
      (closing ??= (async () => {
        await wsSessions.close()
        ownedRouter?.dispose()
        await supervisor?.shutdown()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)))
        })
        sessions.clear()
      })()),
  }
}
