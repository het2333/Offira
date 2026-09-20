import { describe, expect, it } from 'vitest'

import {
  PROTOCOL_VERSION,
  type AgentServerFrame,
  type ClientFrame,
  type DocumentId,
  type SessionId,
} from '@nexusdesk/protocol'
import { createAgentApi } from '../src/agent-api'
import type { NexusClient } from '../src/client'

class StubClient {
  readonly sent: ClientFrame[] = []
  private readonly listeners = new Set<(frame: AgentServerFrame) => void>()

  send(frame: ClientFrame): void {
    this.sent.push(frame)
  }

  onFrame(listener: (frame: AgentServerFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(frame: AgentServerFrame): void {
    for (const listener of this.listeners) listener(frame)
  }
}

describe('AgentApi', () => {
  it('emits stable agent frames and forwards server events without Electron globals', () => {
    const client = new StubClient()
    const api = createAgentApi(client as unknown as NexusClient)
    const received: AgentServerFrame[] = []
    api.onFrame((frame) => received.push(frame))

    api.startTurn({
      prompt: 'Add a total row',
      documentId: 'document-1',
      sessionId: 'session-1',
      provider: 'smoke',
      model: 'smoke-model',
    })
    api.cancelTurn('session-1')
    api.respondApproval('approval-1', 'allowed-once')
    client.emit({
      type: 'agent:event',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'session-1' as SessionId,
      event: { type: 'stream/chunk', data: { text: 'Working' } },
    })

    expect(client.sent.map((frame) => frame.type)).toEqual([
      'agent:start',
      'agent:cancel',
      'approval:response',
    ])
    expect(client.sent[0]).toMatchObject({
      documentId: 'document-1' as DocumentId,
      sessionId: 'session-1' as SessionId,
      prompt: 'Add a total row',
      provider: 'smoke',
      model: 'smoke-model',
    })
    expect(received).toHaveLength(1)
  })
})
