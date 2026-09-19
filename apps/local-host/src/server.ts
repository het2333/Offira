import { createServer, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { PROTOCOL_VERSION } from '@nexusdesk/protocol'
import {
  HostError,
  activateTabRequestSchema,
  closeTabRequestSchema,
  reorderTabRequestSchema,
  shellDocumentSummarySchema,
  shellSettingsPatchSchema,
  type EditorKind,
  type ShellDocumentSummary,
} from '@nexusdesk/office-host'

import { AuthorizedFiles } from './authorized-files'
import { createBootstrapAuth } from './bootstrap-auth'
import type { AgentRouter } from './agent-router'
import { AgentRouter as OwnedAgentRouter } from './agent-router'
import { DocumentRegistry } from './document-registry'
import { expectedRevision, readBinaryBody } from './document-content'
import { DocumentDriverRegistry, type LocalDocument } from './document-driver'
import { HarnessSupervisor } from './harness-supervisor'
import { OperationStore } from './operation-store'
import { acceptHttpOrigin } from './origin-policy'
import { ShellState } from './shell-state'
import { installWsSessionServer } from './ws-session'

export interface RunningLocalHost {
  readonly origin: string
  readonly bootstrapUrl: string
  close(): Promise<void>
}

export interface StartLocalHostOptions {
  documentRegistry?: DocumentRegistry
  agentRouter?: AgentRouter
  documentDrivers?: DocumentDriverRegistry
  documents?: LocalDocument[]
  shellStatePath?: string
  staticAssets?: {
    webRoot: string
    editorRoots: Partial<Record<EditorKind, string>>
  }
  runtimeCommand?: { entry: string; args?: string[]; nodeExecutable?: string }
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

function sendHostError(response: ServerResponse, error: unknown): void {
  if (error instanceof HostError) {
    const status =
      error.code === 'FILE_NOT_AUTHORIZED'
        ? 403
        : error.code === 'DOCUMENT_NOT_FOUND' || error.code === 'TAB_NOT_FOUND'
          ? 404
          : error.code === 'REVISION_CONFLICT'
            ? 409
            : error.code === 'CONTENT_TOO_LARGE'
              ? 413
              : 400
    sendJson(response, status, {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.documentId === undefined ? {} : { documentId: error.documentId }),
    })
    return
  }
  if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
    sendJson(response, 400, {
      code: 'INVALID_REQUEST',
      message: 'The Local Host request was invalid.',
      retryable: false,
    })
    return
  }
  throw error
}

function requireMethod(
  request: import('node:http').IncomingMessage,
  response: ServerResponse,
  method: 'GET' | 'POST',
): boolean {
  if (request.method === method) return true
  sendJson(response, 405, {
    code: 'INVALID_REQUEST',
    message: `This endpoint requires ${method}.`,
    retryable: false,
  })
  return false
}

function requireContentMethod(
  request: import('node:http').IncomingMessage,
  response: ServerResponse,
): request is import('node:http').IncomingMessage & { method: 'GET' | 'PUT' } {
  if (request.method === 'GET' || request.method === 'PUT') return true
  sendJson(response, 405, {
    code: 'INVALID_REQUEST',
    message: 'This endpoint requires GET or PUT.',
    retryable: false,
  })
  return false
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
  const localDocuments = options.documentDrivers?.list() ?? options.documents ?? []
  const shellDocuments = localDocuments.map(
    ({ documentId, title, editorType, revision }) =>
      ({ documentId, title, editorType, revision }) as ShellDocumentSummary,
  )
  const shellState = await ShellState.open({
    path: options.shellStatePath ?? resolve(tmpdir(), `nexusdesk-shell-state-${randomUUID()}.json`),
    documents: shellDocuments,
  })
  const authorizedFiles = new AuthorizedFiles(localDocuments)
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
          documents: localDocuments.map(({ documentId, title, editorType, revision }) => ({
            documentId,
            title,
            editorType,
            revision,
          })),
        })
        return
      }
      if (url.pathname === '/api/shell/bootstrap') {
        if (!requireMethod(request, response, 'GET')) return
        sendJson(response, 200, shellState.bootstrap())
        return
      }
      if (url.pathname === '/api/shell/files') {
        if (!requireMethod(request, response, 'GET')) return
        sendJson(response, 200, { files: authorizedFiles.list() })
        return
      }
      if (url.pathname === '/api/shell/files/open') {
        if (!requireMethod(request, response, 'POST')) return
        try {
          const body = await readJsonBody(request)
          const parsed = activateTabRequestSchema.parse(
            typeof body === 'object' && body !== null && 'fileId' in body
              ? { tabId: (body as { fileId?: unknown }).fileId }
              : body,
          )
          const file = authorizedFiles.require(parsed.tabId)
          sendJson(response, 200, await shellState.openDocument(file.documentId))
          wsSessions.broadcastShellChanged()
        } catch (error: unknown) {
          sendHostError(response, error)
        }
        return
      }
      if (url.pathname === '/api/shell/files/toggle-star') {
        if (!requireMethod(request, response, 'POST')) return
        try {
          const body = await readJsonBody(request)
          const parsed = activateTabRequestSchema.parse(
            typeof body === 'object' && body !== null && 'fileId' in body
              ? { tabId: (body as { fileId?: unknown }).fileId }
              : body,
          )
          sendJson(response, 200, { files: authorizedFiles.toggleStar(parsed.tabId) })
          wsSessions.broadcastShellChanged()
        } catch (error: unknown) {
          sendHostError(response, error)
        }
        return
      }
      if (url.pathname === '/api/shell/tabs/activate') {
        if (!requireMethod(request, response, 'POST')) return
        try {
          const body = activateTabRequestSchema.parse(await readJsonBody(request))
          sendJson(response, 200, await shellState.activate(body.tabId))
          wsSessions.broadcastShellChanged()
        } catch (error: unknown) {
          sendHostError(response, error)
        }
        return
      }
      if (url.pathname === '/api/shell/tabs/close') {
        if (!requireMethod(request, response, 'POST')) return
        try {
          const body = closeTabRequestSchema.parse(await readJsonBody(request))
          sendJson(response, 200, await shellState.close(body.tabId))
          wsSessions.broadcastShellChanged()
        } catch (error: unknown) {
          sendHostError(response, error)
        }
        return
      }
      if (url.pathname === '/api/shell/tabs/reorder') {
        if (!requireMethod(request, response, 'POST')) return
        try {
          const body = reorderTabRequestSchema.parse(await readJsonBody(request))
          sendJson(response, 200, await shellState.reorder(body.tabId, body.toIndex))
          wsSessions.broadcastShellChanged()
        } catch (error: unknown) {
          sendHostError(response, error)
        }
        return
      }
      if (url.pathname === '/api/shell/settings') {
        if (request.method === 'GET') {
          sendJson(response, 200, shellState.bootstrap().settings)
          return
        }
        if (!requireMethod(request, response, 'POST')) return
        try {
          const patch = shellSettingsPatchSchema.parse(await readJsonBody(request))
          sendJson(response, 200, (await shellState.updateSettings(patch)).settings)
          wsSessions.broadcastShellChanged()
        } catch (error: unknown) {
          sendHostError(response, error)
        }
        return
      }
      const contentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/content$/)
      if (contentMatch !== null) {
        if (!requireContentMethod(request, response)) return
        const documentId = decodeURIComponent(contentMatch[1]!)
        try {
          const driver = options.documentDrivers?.require(documentId)
          if (driver === undefined) {
            throw new HostError(
              'DOCUMENT_NOT_FOUND',
              `Document ${documentId} is not registered with this Local Host.`,
              false,
            )
          }
          if (request.method === 'GET') {
            if (driver.readContent === undefined) {
              throw new HostError(
                'UNSUPPORTED_CAPABILITY',
                `Document ${documentId} does not expose binary content.`,
                false,
              )
            }
            const content = await driver.readContent()
            response.writeHead(200, {
              'Content-Type': content.contentType,
              'Content-Length': content.bytes.byteLength,
              'Cache-Control': 'no-store',
            })
            response.end(content.bytes)
            return
          }
          if (driver.writeContent === undefined) {
            throw new HostError(
              'UNSUPPORTED_CAPABILITY',
              `Document ${documentId} does not accept binary content.`,
              false,
            )
          }
          const revision = expectedRevision(request)
          const bytes = await readBinaryBody(request)
          sendJson(
            response,
            200,
            shellDocumentSummarySchema.parse(await driver.writeContent(bytes, revision)),
          )
        } catch (error: unknown) {
          if (error instanceof HostError && error.code === 'UNSUPPORTED_CAPABILITY') {
            sendJson(response, 405, {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
            })
          } else {
            sendHostError(response, error)
          }
        }
        return
      }
      const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/(bootstrap|[^/]+)$/)
      if (documentMatch !== null) {
        const documentId = decodeURIComponent(documentMatch[1]!)
        const action = documentMatch[2]!
        if (options.documentDrivers === undefined) {
          sendJson(response, 404, {
            code: 'DOCUMENT_NOT_FOUND',
            message: `Document ${documentId} is not registered with this Local Host.`,
            retryable: false,
            documentId,
          })
          return
        }
        try {
          if (!requireMethod(request, response, action === 'bootstrap' ? 'GET' : 'POST')) return
          const result =
            action === 'bootstrap'
              ? await options.documentDrivers.bootstrap(documentId, origin)
              : await options.documentDrivers.execute(
                  documentId,
                  action,
                  await readJsonBody(request),
                )
          sendJson(response, 200, result)
        } catch (error: unknown) {
          if (error instanceof HostError || error instanceof SyntaxError) {
            sendHostError(response, error)
          } else {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : 'document request failed',
            })
          }
        }
        return
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'not found' })
        return
      }
      if (options.staticAssets !== undefined) {
        const editorMatch = url.pathname.match(/^\/(docs|sheets|slides|pdf|markdown|html)(?:\/|$)/)
        if (editorMatch !== null) {
          const editor = editorMatch[1] as EditorKind
          const editorRoot = options.staticAssets.editorRoots[editor]
          if (editorRoot === undefined) {
            sendJson(response, 404, { error: `${editor} editor assets are unavailable` })
            return
          }
          const relative = url.pathname.replace(new RegExp(`^/${editor}/?`), '') || 'index.html'
          const file =
            (await staticFile(editorRoot, relative)) ?? (await staticFile(editorRoot, 'index.html'))
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

  const wsSessions = installWsSessionServer(server, {
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
        await options.documentDrivers?.close()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)))
        })
        sessions.clear()
      })()),
  }
}
