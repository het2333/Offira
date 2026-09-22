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
  HarnessClientFrame,
  HarnessServerFrame,
} from '@nexusdesk/protocol'
import type { OfficeEditorType, OfficeTurnContext } from './office-session-binding'

export { PROTOCOL_VERSION } from '@nexusdesk/protocol'
import { parseAgentToolResult, persistenceReferenceSchema } from '@nexusdesk/protocol'

export interface RuntimeEditorResponseFrame extends EditorResponseFrame {
  /** Host-authoritative revision after the editor request reached a terminal state. */
  currentRevision: Revision
}

/** Preserve old editor replies while checking small durable receipts from opted-in drivers. */
export function validateRuntimeEditorResponse(frame: RuntimeEditorResponseFrame): RuntimeEditorResponseFrame {
  parseAgentToolResult(frame.result)
  if (!Number.isSafeInteger(frame.currentRevision) || frame.currentRevision < 0) throw Error('Invalid Host revision.')
  if (frame.persistence) {
    const receipt = persistenceReferenceSchema.parse(frame.persistence)
    if (receipt.operationId !== frame.target.operationId || !frame.result.ok) throw Error('Persistence operation does not match its successful result.')
    if (receipt.workingRevision > frame.currentRevision) throw Error('Host revision is behind its persistence receipt.')
  }
  return frame
}

interface RuntimeFrameBase {
  protocolVersion: number
  id: string
}

export type RuntimeRequestFrame =
  | (RuntimeFrameBase & { type: 'credential:request'; ref: string; action: 'describe' | 'set' | 'unset'; value?: string })
  | (RuntimeFrameBase & { type: 'office:resource'; url: string })
  | (RuntimeFrameBase & {
      type: 'office:client'
      clientId: ClientId
      sessionId: SessionId
      frame: Exclude<HarnessClientFrame, { type: 'harness:bind' }>
      context?: OfficeTurnContext
    })
  | (RuntimeFrameBase & { type: 'office:detach'; clientId: ClientId })
  | (RuntimeFrameBase & {
      type: 'office:bind'
      hostId: string
      documentId: DocumentId
      clientId: ClientId
      editorType: OfficeEditorType
      revision: Revision
      cwd: string
      provider?: string
      model?: string
    })
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
  | { type: 'credential:result'; protocolVersion: number; id: string; info?: { configured: boolean; source?: string; writable: boolean }; error?: 'READ_ONLY' | 'UNAVAILABLE' }
  | { type: 'office:resource-result'; protocolVersion: number; id: string; resource: import('./office-resource').OfficeResource }
  | { type: 'office:client-result'; protocolVersion: number; clientId: ClientId; frame: HarnessServerFrame }
  | {
      type: 'ready'
      protocolVersion: number
      pid: number
      startedBundles: string[]
      officeClientModules?: string[]
      toolCatalogs: {
        docs: readonly string[]
        sheets: readonly string[]
        slides: readonly string[]
        pdf: readonly string[]
        markdown: readonly string[]
        html: readonly string[]
      }
    }
  | { type: 'fatal'; protocolVersion: number; message: string }
  | {
      type: 'office:bound'
      protocolVersion: number
      id: string
      sessionId: SessionId
      resumed: boolean
    }
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
