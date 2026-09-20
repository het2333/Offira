import {
  PROTOCOL_VERSION,
  type AgentServerFrame,
  type ApprovalOutcome,
  type DocumentId,
  type RequestId,
  type SessionId,
} from '@nexusdesk/protocol'

import type { NexusClient } from './client'

export interface AgentApi {
  startTurn(input: { prompt: string; documentId: string; sessionId: string; provider?: string; model?: string }): void
  cancelTurn(sessionId: string): void
  respondApproval(id: string, outcome: ApprovalOutcome): void
  onFrame(callback: (frame: AgentServerFrame) => void): () => void
}

function requestId(prefix: string): RequestId {
  return `${prefix}-${globalThis.crypto.randomUUID()}` as RequestId
}

export function createAgentApi(client: NexusClient): AgentApi {
  return {
    startTurn(input) {
      client.send({
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: requestId('start'),
        sessionId: input.sessionId as SessionId,
        documentId: input.documentId as DocumentId,
        prompt: input.prompt,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.model === undefined ? {} : { model: input.model }),
      })
    },
    cancelTurn(sessionId) {
      client.send({
        type: 'agent:cancel',
        protocolVersion: PROTOCOL_VERSION,
        id: requestId('cancel'),
        sessionId: sessionId as SessionId,
      })
    },
    respondApproval(id, outcome) {
      client.send({
        type: 'approval:response',
        protocolVersion: PROTOCOL_VERSION,
        id: id as RequestId,
        outcome,
      })
    },
    onFrame(callback) {
      return client.onFrame(callback)
    },
  }
}
