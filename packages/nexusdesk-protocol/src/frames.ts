import type { AgentApprovalProposal, AgentToolResult, JsonValue } from './editor'
import type {
  ClientId,
  DocumentId,
  MutationTarget,
  OperationId,
  RendererInstanceId,
  RequestId,
  Revision,
  SessionId,
} from './identity'

export const PROTOCOL_VERSION = 1 as const

interface FrameBase {
  protocolVersion: typeof PROTOCOL_VERSION
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface AgentStartFrame extends FrameBase {
  type: 'agent:start'
  id: RequestId
  sessionId: SessionId
  documentId: DocumentId
  prompt: string
  provider?: string
  model?: string
}

export interface AgentCancelFrame extends FrameBase {
  type: 'agent:cancel'
  id: RequestId
  sessionId: SessionId
}

export interface ApprovalResponseFrame extends FrameBase {
  type: 'approval:response'
  id: RequestId
  outcome: ApprovalOutcome
}

export interface EditorRegisterFrame extends FrameBase {
  type: 'editor:register'
  id: RequestId
  clientId: ClientId
  rendererInstanceId: RendererInstanceId
  documentId: DocumentId
  editorType: string
  revision: Revision
}

export interface EditorRevisionFrame extends FrameBase {
  type: 'editor:revision'
  id: RequestId
  clientId: ClientId
  documentId: DocumentId
  revision: Revision
}

export interface EditorDetachFrame extends FrameBase {
  type: 'editor:detach'
  id: RequestId
  clientId: ClientId
  documentId: DocumentId
}

export interface EditorResponseFrame extends FrameBase {
  type: 'editor:result'
  id: RequestId
  target: MutationTarget
  result: AgentToolResult
}

export interface OperationLookupFrame extends FrameBase {
  type: 'operation:lookup'
  id: RequestId
  operationId: OperationId
}

export type ClientFrame =
  | AgentStartFrame
  | AgentCancelFrame
  | ApprovalResponseFrame
  | EditorRegisterFrame
  | EditorRevisionFrame
  | EditorDetachFrame
  | EditorResponseFrame
  | OperationLookupFrame

export interface ServerReadyFrame extends FrameBase {
  type: 'server:ready'
  clientId: ClientId
}

export interface FatalFrame extends FrameBase {
  type: 'fatal'
  message: string
}

export interface AgentEventFrame extends FrameBase {
  type: 'agent:event'
  sessionId: SessionId
  event: {
    type: string
    seq?: number
    data?: JsonValue
  }
}

export interface ApprovalRequestFrame extends FrameBase {
  type: 'approval:request'
  id: RequestId
  sessionId: SessionId
  toolName: string
  reason?: string
  proposal?: AgentApprovalProposal
}

export interface EditorRequestFrame extends FrameBase {
  type: 'editor:request'
  id: RequestId
  target: MutationTarget
  command: string
  arguments: JsonValue
  approval?: { id: RequestId; planHash: string }
}

export interface OperationResultFrame extends FrameBase {
  type: 'operation:result'
  id: RequestId
  operationId: OperationId
  result: AgentToolResult
}

export type AgentServerFrame =
  | ServerReadyFrame
  | FatalFrame
  | AgentEventFrame
  | ApprovalRequestFrame
  | EditorRequestFrame
  | OperationResultFrame
