import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import {
  PROTOCOL_VERSION,
  type ClientId,
  type DocumentId,
  type Revision,
} from '@nexusdesk/protocol'
import { DocumentRegistry, DocumentRegistryError } from '../src/document-registry'
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

async function openSession(
  host: RunningLocalHost,
  cookie?: string,
): Promise<{ socket: WebSocket; clientId: ClientId }> {
  cookie ??= await sessionCookie(host)
  const socket = new WebSocket(wsUrl(host.origin), {
    headers: { Cookie: cookie, Origin: host.origin },
  })
  const frame = await new Promise<{ clientId: ClientId }>((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString()) as { clientId: ClientId }))
    socket.once('error', reject)
  })
  return { socket, clientId: frame.clientId }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}

async function closeCode(socket: WebSocket): Promise<number | undefined> {
  return await Promise.race([
    new Promise<number>((resolve) => socket.once('close', resolve)),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
  ])
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

  it('registers a document to the socket client and detaches it on close', async () => {
    const documents = new DocumentRegistry()
    const documentId = 'document-1' as DocumentId
    const revision = 1 as Revision
    running = await startLocalHost({
      documentRegistry: documents,
      documents: [{ documentId, title: 'Forecast.xlsx', editorType: 'sheets', revision }],
    })
    const { socket, clientId } = await openSession(running)
    socket.send(
      JSON.stringify({
        type: 'editor:register',
        protocolVersion: PROTOCOL_VERSION,
        id: 'register-1',
        clientId,
        documentId,
        editorType: 'sheets',
        revision,
      }),
    )

    await until(() => {
      try {
        return documents.assertOwner({ documentId, clientId, revision }).attached
      } catch {
        return false
      }
    })
    socket.close()
    await until(() => {
      try {
        documents.assertOwner({ documentId, clientId, revision })
        return false
      } catch (error) {
        return error instanceof DocumentRegistryError && error.code === 'DOCUMENT_DETACHED'
      }
    })
  })

  it('closes a client that claims another client id', async () => {
    const documents = new DocumentRegistry()
    running = await startLocalHost({ documentRegistry: documents })
    const { socket } = await openSession(running)
    socket.send(
      JSON.stringify({
        type: 'editor:register',
        protocolVersion: PROTOCOL_VERSION,
        id: 'register-1',
        clientId: 'spoofed-client',
        documentId: 'document-1',
        editorType: 'sheets',
        revision: 1,
      }),
    )

    const code = await new Promise<number>((resolve) => socket.once('close', resolve))
    expect(code).toBe(1008)
  })

  it('rejects a second client without replacing the authorized document owner', async () => {
    const documents = new DocumentRegistry()
    const documentId = 'document-1' as DocumentId
    const revision = 1 as Revision
    running = await startLocalHost({
      documentRegistry: documents,
      documents: [{ documentId, title: 'Forecast.xlsx', editorType: 'sheets', revision }],
    })
    const cookie = await sessionCookie(running)
    const owner = await openSession(running, cookie)
    owner.socket.send(JSON.stringify({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-owner',
      clientId: owner.clientId,
      documentId,
      editorType: 'sheets',
      revision,
    }))
    await until(() => {
      try {
        return documents.assertClient(documentId, owner.clientId).attached
      } catch {
        return false
      }
    })

    const attacker = await openSession(running, cookie)
    attacker.socket.send(JSON.stringify({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-attacker',
      clientId: attacker.clientId,
      documentId,
      editorType: 'sheets',
      revision,
    }))

    expect(await closeCode(attacker.socket)).toBe(1008)
    expect(documents.assertOwner({ documentId, clientId: owner.clientId, revision }).clientId)
      .toBe(owner.clientId)
    owner.socket.close()
  })

  it('uses Host metadata and ignores a former owner socket closing after handoff', async () => {
    const documents = new DocumentRegistry()
    const documentId = 'document-1' as DocumentId
    const revision = 3 as Revision
    running = await startLocalHost({
      documentRegistry: documents,
      documents: [{ documentId, title: 'Report.docx', editorType: 'docs', revision }],
    })
    const cookie = await sessionCookie(running)
    const former = await openSession(running, cookie)
    former.socket.send(JSON.stringify({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-former',
      clientId: former.clientId,
      documentId,
      editorType: 'docs',
      revision,
    }))
    await until(() => {
      try {
        return documents.assertClient(documentId, former.clientId).attached
      } catch {
        return false
      }
    })
    former.socket.send(JSON.stringify({
      type: 'editor:detach',
      protocolVersion: PROTOCOL_VERSION,
      id: 'detach-former',
      clientId: former.clientId,
      documentId,
    }))
    await until(() => {
      try {
        documents.assertClient(documentId, former.clientId)
        return false
      } catch (error) {
        return error instanceof DocumentRegistryError && error.code === 'DOCUMENT_DETACHED'
      }
    })

    const current = await openSession(running, cookie)
    current.socket.send(JSON.stringify({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-current',
      clientId: current.clientId,
      documentId,
      editorType: 'docs',
      revision,
    }))
    await until(() => {
      try {
        return documents.assertClient(documentId, current.clientId).attached
      } catch {
        return false
      }
    })

    former.socket.close()
    await new Promise<void>((resolve) => former.socket.once('close', () => resolve()))
    expect(documents.assertOwner({ documentId, clientId: current.clientId, revision }).clientId)
      .toBe(current.clientId)
    current.socket.close()
  })

  it('broadcasts sequenced Shell changes after a persisted tab mutation', async () => {
    running = await startLocalHost({
      documents: [
        {
          documentId: 'document-1',
          title: 'Forecast.xlsx',
          editorType: 'sheets',
          revision: 1,
        },
      ],
    })
    const cookie = await sessionCookie(running)
    const socket = new WebSocket(wsUrl(running.origin), {
      headers: { Cookie: cookie, Origin: running.origin },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('message', () => resolve())
      socket.once('error', reject)
    })
    const changed = new Promise<unknown>((resolve) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString())))
    })

    const response = await fetch(`${running.origin}/api/shell/tabs/activate`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: 'document:document-1' }),
    })

    expect(response.status).toBe(200)
    await expect(changed).resolves.toEqual({
      type: 'shell:changed',
      protocolVersion: PROTOCOL_VERSION,
      sequence: 1,
    })
    socket.close()
  })
})
