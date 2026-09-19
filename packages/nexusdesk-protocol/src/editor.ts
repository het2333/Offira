import type { DocumentId, MutationTarget, Revision, TransactionId } from './identity'

export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface AgentWarning {
  code: string
  message: string
  target?: string
}

export interface AgentApprovalProposal {
  planHash: string
  summary: string
  targets: string[]
  warnings: AgentWarning[]
}

export interface AgentIssue {
  code: string
  message: string
  target?: string
}

export interface AgentToolResult {
  ok: boolean
  summary: string
  changes?: {
    targets: string[]
    count: number
  }
  warnings: AgentWarning[]
  verification?: {
    passed: boolean
    issues: AgentIssue[]
  }
  continuation?: {
    suggestedTool?: string
    reason?: string
  }
  transactionId?: TransactionId
  /** Bounded, JSON-safe payload for read-oriented tools. */
  data?: JsonValue
}

export interface EditorCapabilities {
  editorType: string
  commands: string[]
  canUndo: boolean
  canSave: boolean
  canExport: boolean
}

export interface AgentDocumentSummary {
  documentId: DocumentId
  revision: Revision
  title: string
  summary: string
}

export interface ReadRequest {
  documentId: DocumentId
  command: string
  arguments: JsonValue
}

export interface AgentReadResult extends AgentToolResult {
  data?: JsonValue
}

export interface EditRequest extends MutationTarget {
  command: string
  arguments: JsonValue
}

export interface EditPlan<TOperation extends JsonValue = JsonValue> {
  target: MutationTarget
  planId: string
  planHash: string
  summary: string
  operations: TOperation[]
  warnings: AgentWarning[]
}

export interface ApprovedEditPlan<
  TOperation extends JsonValue = JsonValue,
> extends EditPlan<TOperation> {
  approvalId: string
}

export type AgentEditResult = AgentToolResult
export type VerificationResult = NonNullable<AgentToolResult['verification']>
export type AgentSaveResult = AgentToolResult

export interface ExportRequest {
  documentId: DocumentId
  format: string
  destination: string
}

export type AgentExportResult = AgentToolResult

/** Engine-neutral capability implemented by each browser editor. */
export interface EditorAdapter {
  readonly editorType: string
  capabilities(): EditorCapabilities
  snapshot(documentId: DocumentId): Promise<AgentDocumentSummary>
  read(request: ReadRequest): Promise<AgentReadResult>
  propose(request: EditRequest): Promise<EditPlan>
  apply(plan: ApprovedEditPlan): Promise<AgentEditResult>
  verify(documentId: DocumentId): Promise<VerificationResult>
  undo(transactionId: TransactionId): Promise<AgentEditResult>
  save(documentId: DocumentId): Promise<AgentSaveResult>
  export(request: ExportRequest): Promise<AgentExportResult>
}
