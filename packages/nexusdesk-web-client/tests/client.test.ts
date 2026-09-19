import { describe, expect, it } from 'vitest'

import {
  PROTOCOL_VERSION,
  type ClientId,
  type DocumentId,
  type OperationId,
  type RequestId,
  type Revision,
  type SessionId,
} from '@nexusdesk/protocol'
import {
  createNexusClient,
  NexusClientError,
  type NexusSocket,
  type NexusSocketEventMap,
} from '../src/client'
import { registerEditor } from '../src/editor-registration'

type Listener<K extends keyof NexusSocketEventMap> = (event: NexusSocketEventMap[K]) => void

class FakeSocket implements NexusSocket {
  readonly sent: string[] = []
  private readonly listeners = new Map<keyof NexusSocketEventMap, Set<(event: never) => void>>()

  addEventListener<K extends keyof NexusSocketEventMap>(type: K, listener: Listener<K>): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener as (event: never) => void)
    this.listeners.set(type, listeners)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.emit('close', { code: 1000 })
  }

  listenerCount(type: keyof NexusSocketEventMap): number {
    return this.listeners.get(type)?.size ?? 0
  }

  emit<K extends keyof NexusSocketEventMap>(type: K, event: NexusSocketEventMap[K]): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }

  serverReady(clientId: ClientId): void {
    this.emit('message', {
      data: JSON.stringify({ type: 'server:ready', protocolVersion: PROTOCOL_VERSION, clientId }),
    })
  }
}

function createHarness() {
  const sockets: FakeSocket[] = []
  const timers: Array<{ delay: number; callback: () => void }> = []
  const client = createNexusClient({
    url: 'ws://127.0.0.1:43123/ws',
    webSocketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    schedule: (callback, delay) => {
      timers.push({ callback, delay })
      return timers.length
    },
    cancelSchedule: () => undefined,
  })
  return { client, sockets, timers }
}

const requestId = 'lookup-1' as RequestId
const operationId = 'operation-1' as OperationId
const sessionId = 'session-1' as SessionId
const documentId = 'document-1' as DocumentId
const revision = 1 as Revision

function expectConnectionLost(action: () => void): void {
  try {
    action()
    throw new Error('expected a connection error')
  } catch (error) {
    expect(error).toBeInstanceOf(NexusClientError)
    expect((error as NexusClientError).code).toBe('CONNECTION_LOST')
  }
}

describe('NexusClient', () => {
  it('installs one listener per connection and correlates replies by request id', async () => {
    const { client, sockets } = createHarness()
    client.connect()
    const socket = sockets[0]!

    expect(socket.listenerCount('open')).toBe(1)
    expect(socket.listenerCount('message')).toBe(1)
    expect(socket.listenerCount('close')).toBe(1)
    expect(socket.listenerCount('error')).toBe(1)

    socket.emit('open', {})
    socket.serverReady('client-1' as ClientId)
    const reply = client.request({
      type: 'operation:lookup',
      protocolVersion: PROTOCOL_VERSION,
      id: requestId,
      operationId,
    })
    socket.emit('message', {
      data: JSON.stringify({
        type: 'operation:result',
        protocolVersion: PROTOCOL_VERSION,
        id: requestId,
        operationId,
        result: { ok: true, summary: 'already applied', warnings: [] },
      }),
    })

    await expect(reply).resolves.toMatchObject({ type: 'operation:result', id: requestId })
  })

  it('caps reconnect backoff and never queues mutation or approval frames', async () => {
    const { client, sockets, timers } = createHarness()
    client.connect()
    sockets[0]!.serverReady('client-1' as ClientId)
    client.send({
      type: 'agent:start',
      protocolVersion: PROTOCOL_VERSION,
      id: 'start-1' as RequestId,
      sessionId,
      documentId,
      prompt: 'Update the forecast',
    })
    sockets[0]!.emit('close', { code: 1006 })

    expectConnectionLost(() =>
      client.send({
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: 'start-2' as RequestId,
        sessionId,
        documentId,
        prompt: 'Do not replay me',
      }),
    )
    expectConnectionLost(() =>
      client.send({
        type: 'approval:response',
        protocolVersion: PROTOCOL_VERSION,
        id: 'approval-1' as RequestId,
        outcome: 'allowed-once',
      }),
    )

    const lookup = client.request({
      type: 'operation:lookup',
      protocolVersion: PROTOCOL_VERSION,
      id: requestId,
      operationId,
    })
    for (let attempt = 0; attempt < 6; attempt += 1) {
      timers.at(-1)!.callback()
      sockets.at(-1)!.emit('close', { code: 1006 })
    }
    expect(timers.map((timer) => timer.delay)).toEqual([
      250, 500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ])

    timers.at(-1)!.callback()
    sockets.at(-1)!.serverReady('client-8' as ClientId)
    const allSent = sockets.flatMap((socket) =>
      socket.sent.map((value) => JSON.parse(value) as { type: string }),
    )
    expect(allSent.filter((frame) => frame.type === 'agent:start')).toHaveLength(1)
    expect(allSent.filter((frame) => frame.type === 'operation:lookup')).toHaveLength(1)
    sockets.at(-1)!.emit('message', {
      data: JSON.stringify({
        type: 'operation:result',
        protocolVersion: PROTOCOL_VERSION,
        id: requestId,
        operationId,
        result: { ok: true, summary: 'not found', warnings: [] },
      }),
    })
    await expect(lookup).resolves.toMatchObject({ id: requestId })
  })

  it('registers the editor again with the new client identity after reconnect', () => {
    const { client, sockets, timers } = createHarness()
    client.connect()
    sockets[0]!.serverReady('client-1' as ClientId)
    const registration = registerEditor(client, { documentId, editorType: 'sheets', revision })

    sockets[0]!.emit('close', { code: 1006 })
    registration.updateRevision(2 as Revision)
    timers[0]!.callback()
    sockets[1]!.serverReady('client-2' as ClientId)

    const first = JSON.parse(sockets[0]!.sent[0]!) as { type: string; clientId: string }
    const second = JSON.parse(sockets[1]!.sent[0]!) as {
      type: string
      clientId: string
      revision: number
    }
    expect(first).toMatchObject({ type: 'editor:register', clientId: 'client-1' })
    expect(second).toMatchObject({ type: 'editor:register', clientId: 'client-2', revision: 2 })
    registration.dispose()
  })

  it('ignores versioned Shell broadcasts without closing the Agent connection', () => {
    const { client, sockets } = createHarness()
    const frames: string[] = []
    client.onFrame((frame) => frames.push(frame.type))
    client.connect()
    sockets[0]!.serverReady('client-1' as ClientId)

    sockets[0]!.emit('message', {
      data: JSON.stringify({
        type: 'shell:changed',
        protocolVersion: PROTOCOL_VERSION,
        sequence: 1,
      }),
    })

    expect(client.state).toBe('ready')
    expect(frames).toEqual(['server:ready'])
  })
})
