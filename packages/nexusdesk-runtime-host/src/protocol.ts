import type {
  AgentEventFrame,
  AgentApprovalProposal,
  ApprovalOutcome,
  ClientId,
  DocumentId,
  EditorRequestFrame,
  EditorResponseFrame,
  Revision,
  SessionId,
} from '@nexusdesk/protocol'

export { PROTOCOL_VERSION } from '@nexusdesk/protocol'

export interface RuntimeEditorResponseFrame extends EditorResponseFrame {
  /** Host-authoritative revision after the editor request reached a terminal state. */
  currentRevision: Revision
}

interface RuntimeFrameBase {
  protocolVersion: number
  id: string
}

export type RuntimeRequestFrame =
  | (RuntimeFrameBase & {
      type: 'agent:start'
      sessionId: SessionId
      documentId: DocumentId
      clientId: ClientId
      editorType: string
      revision: Revision
      cwd: string
      prompt: string
      provider?: string
      model?: string
    })
  | (RuntimeFrameBase & { type: 'agent:cancel'; sessionId: SessionId; reason: 'user' })
  | (RuntimeFrameBase & { type: 'approval:response'; outcome: ApprovalOutcome })
  | RuntimeEditorResponseFrame
  | (RuntimeFrameBase & { type: 'shutdown' })

export type RuntimeResponseFrame =
  | {
      type: 'ready'
      protocolVersion: number
      pid: number
      startedBundles: string[]
      toolCatalogs: {
        docs: readonly string[]
        sheets: readonly string[]
        slides: readonly string[]
        markdown: readonly string[]
        html: readonly string[]
      }
    }
  | { type: 'fatal'; protocolVersion: number; message: string }
  | { type: 'shutdown-complete'; protocolVersion: number }
  | AgentEventFrame
  | {
      type: 'approval:request'
      protocolVersion: number
      id: string
      sessionId: SessionId
      toolName: string
      reason?: string
      proposal?: AgentApprovalProposal
    }
  | EditorRequestFrame

export interface HarnessStreamChunk {
  type: string
  index?: number
  text?: string
  blockType?: string
  name?: string
  [key: string]: unknown
}

export interface HarnessDurableEvent {
  type: string
  seq?: number
  data?: unknown
}
