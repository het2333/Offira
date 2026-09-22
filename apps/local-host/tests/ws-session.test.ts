import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import {
  PROTOCOL_VERSION,
  type ClientId,
  type DocumentId,
  type Revision,
} from '@nexusdesk/protocol'
import type { ShellDocumentSummary } from '@nexusdesk/office-host'
import { DocumentRegistry, DocumentRegistryError } from '../src/document-registry'
import { DocumentDriverRegistry, type LocalDocumentDriver } from '../src/document-driver'
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
    const receipts: unknown[] = []
    socket.on('message', data => receipts.push(JSON.parse(data.toString())))
    socket.send(
      JSON.stringify({
        type: 'editor:register',
        protocolVersion: PROTOCOL_VERSION,
        id: 'register-1',
        clientId,
        rendererInstanceId: 'renderer-1',
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
    expect(receipts).toContainEqual({ type: 'editor:attached', protocolVersion: 1,
      id: 'register-1', documentId, revision })
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
        rendererInstanceId: 'renderer-spoofed',
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
      rendererInstanceId: 'renderer-owner',
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
      rendererInstanceId: 'renderer-attacker',
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
      rendererInstanceId: 'renderer-former',
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
      rendererInstanceId: 'renderer-current',
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

  it('distinguishes a Sheets transport reconnect from a new renderer reload', async () => {
    const documents = new DocumentRegistry()
    const driver: LocalDocumentDriver = {
      document: {
        documentId: 'sheet-1',
        title: 'Forecast.xlsx',
        editorType: 'sheets',
        revision: 1,
      },
      async bootstrap() { return {} },
      async execute() { return {} },
      async close() {},
    }
    running = await startLocalHost({
      documentRegistry: documents,
      documentDrivers: new DocumentDriverRegistry([driver]),
    })
    const cookie = await sessionCookie(running)
    const live = await openSession(running, cookie)
    live.socket.send(JSON.stringify({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-live',
      clientId: live.clientId,
      rendererInstanceId: 'renderer-live',
      documentId: 'sheet-1',
      editorType: 'sheets',
      revision: 1,
    }))
    await until(() => {
      try {
        return documents.assertClient('sheet-1' as DocumentId, live.clientId).revision === 1
      } catch {
        return false
      }
    })
    live.socket.send(JSON.stringify({
      type: 'editor:revision',
      protocolVersion: PROTOCOL_VERSION,
      id: 'revision-live',
      clientId: live.clientId,
      documentId: 'sheet-1',
      revision: 2,
    }))
    await until(() => documents.assertClient('sheet-1' as DocumentId, live.clientId).revision === 2)
    live.socket.send(JSON.stringify({
      type: 'editor:detach',
      protocolVersion: PROTOCOL_VERSION,
      id: 'detach-live',
      clientId: live.clientId,
      documentId: 'sheet-1',
    }))
    await until(() => {
      try {
        documents.assertClient('sheet-1' as DocumentId, live.clientId)
        return false
      } catch (error) {
        return error instanceof DocumentRegistryError && error.code === 'DOCUMENT_DETACHED'
      }
    })

    const transportReconnect = await openSession(running, cookie)
    transportReconnect.socket.send(JSON.stringify({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-transport-reconnect',
      clientId: transportReconnect.clientId,
      rendererInstanceId: 'renderer-live',
      documentId: 'sheet-1',
      editorType: 'sheets',
      revision: 2,
    }))
    await until(() => {
      try {
        return documents.assertClient(
          'sheet-1' as DocumentId,
          transportReconnect.clientId,
        ).revision === 2
      } catch {
        return false
      }
    })
    transportReconnect.socket.send(JSON.stringify({
      type: 'editor:detach',
      protocolVersion: PROTOCOL_VERSION,
      id: 'detach-transport-reconnect',
      clientId: transportReconnect.clientId,
      documentId: 'sheet-1',
    }))
    await until(() => {
      try {
        documents.assertClient('sheet-1' as DocumentId, transportReconnect.clientId)
        return false
      } catch (error) {
        return error instanceof DocumentRegistryError && error.code === 'DOCUMENT_DETACHED'
      }
    })

    const reloaded = await openSession(running, cookie)
    reloaded.socket.send(JSON.stringify({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-reloaded',
      clientId: reloaded.clientId,
      rendererInstanceId: 'renderer-reloaded',
      documentId: 'sheet-1',
      editorType: 'sheets',
      revision: 1,
    }))

    await until(() => {
      try {
        return documents.assertClient('sheet-1' as DocumentId, reloaded.clientId).revision === 1
      } catch {
        return false
      }
    })
    live.socket.close()
    transportReconnect.socket.close()
    reloaded.socket.close()
  })

  it('refreshes a detached Docs document after an HTTP save advances the driver revision', async () => {
    const documents = new DocumentRegistry()
    const driver: LocalDocumentDriver = {
      document: {
        documentId: 'doc-1',
        title: 'Report.docx',
        editorType: 'docs',
        revision: 1,
      },
      async bootstrap() { return {} },
      async execute() { return {} },
      async writeContent(_bytes, expectedRevision) {
        if (expectedRevision !== driver.document.revision) throw new Error('stale revision')
        driver.document.revision += 1
        return { ...driver.document } as ShellDocumentSummary
      },
      async close() {},
    }
    running = await startLocalHost({
      documentRegistry: documents,
      documentDrivers: new DocumentDriverRegistry([driver]),
    })
    const cookie = await sessionCookie(running)
    const beforeSave = await openSession(running, cookie)
    beforeSave.socket.send(JSON.stringify({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-before-save',
      clientId: beforeSave.clientId,
      rendererInstanceId: 'renderer-before-save',
      documentId: 'doc-1',
      editorType: 'docs',
      revision: 1,
    }))
    await until(() => {
      try {
        return documents.assertClient('doc-1' as DocumentId, beforeSave.clientId).revision === 1
      } catch {
        return false
      }
    })
    const saved = await fetch(`${running.origin}/api/documents/doc-1/content`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/octet-stream',
        'If-Match': '1',
      },
      body: new Uint8Array([80, 75, 3, 4]),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ revision: 2 })
    expect(documents.assertOwner({
      documentId: 'doc-1' as DocumentId,
      clientId: beforeSave.clientId,
      revision: 2 as Revision,
    }).revision).toBe(2)
    beforeSave.socket.close()
    await until(() => {
      try {
        documents.assertClient('doc-1' as DocumentId, beforeSave.clientId)
        return false
      } catch (error) {
        return error instanceof DocumentRegistryError && error.code === 'DOCUMENT_DETACHED'
      }
    })

    const afterSave = await openSession(running, cookie)
    afterSave.socket.send(JSON.stringify({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: 'register-after-save',
      clientId: afterSave.clientId,
      rendererInstanceId: 'renderer-after-save',
      documentId: 'doc-1',
      editorType: 'docs',
      revision: 2,
    }))

    await until(() => {
      try {
        return documents.assertClient('doc-1' as DocumentId, afterSave.clientId).revision === 2
      } catch {
        return false
      }
    })
    afterSave.socket.close()
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
