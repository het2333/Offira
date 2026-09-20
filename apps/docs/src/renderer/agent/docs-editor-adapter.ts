import type {
  AgentDocumentSummary,
  AgentEditResult,
  AgentExportResult,
  AgentReadResult,
  AgentSaveResult,
  ApprovedEditPlan,
  ClientId,
  DocumentId,
  EditPlan,
  EditRequest,
  EditorAdapter,
  ExportRequest,
  JsonValue,
  OperationId,
  Revision,
  TransactionId,
  VerificationResult,
} from '@nexusdesk/protocol'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

import {
  executeDocsCommand,
  type DocsCommand,
  type DocsCommandResult,
} from './docs-command-executor'
import type { FileActionContext } from '../file-actions'

const MAX_OPERATIONS = 200
const MAX_TARGETS = 200
const MAX_WARNINGS = 100
const MAX_PAYLOAD_BYTES = 256 * 1024

export interface DocsDocumentState {
  documentId: DocumentId
  clientId: ClientId
  revision: Revision
  title: string
  attached: boolean
}

export interface DocsEditorAdapterOptions {
  context(): FileActionContext
  document(): DocsDocumentState
  consumeApproval(approvalId: string, planHash: string): boolean | Promise<boolean>
  execute?(
    context: FileActionContext,
    command: DocsCommand,
    payload: unknown,
  ): Promise<DocsCommandResult>
}

interface RecordedOperation {
  planHash: string
  result: Promise<AgentEditResult>
}

interface ProposedContentSnapshot {
  planHash: string
  contentHash: string
}

function failure(code: string, message: string): AgentEditResult {
  return { ok: false, summary: message, warnings: [{ code, message }] }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

async function sha256(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(value)),
  )
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hashPlan(
  plan: Pick<EditPlan, 'target' | 'operations'>,
  contentHash: string,
): Promise<string> {
  return sha256({ target: plan.target, operations: plan.operations, contentHash })
}

function transactionId(): TransactionId {
  return `docs-${globalThis.crypto.randomUUID()}` as TransactionId
}

function record(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Docs operations must be JSON objects')
  }
  return value
}

function operationsFrom(request: EditRequest): JsonValue[] {
  const args = record(request.arguments)
  if (!Array.isArray(args.ops)) throw new Error('apply_ops requires an "ops" array')
  if (args.ops.length === 0) throw new Error('apply_ops requires at least one operation')
  if (args.ops.length > MAX_OPERATIONS) {
    throw new Error(`A Docs plan may contain at most ${MAX_OPERATIONS} operations`)
  }
  for (const operation of args.ops) record(operation)
  return args.ops
}

function operationTargets(operation: JsonValue): string[] {
  const value = record(operation)
  const op = typeof value.op === 'string' ? value.op : 'change'
  if (typeof value.blockIndex === 'number') return [`block:${String(value.blockIndex)}`]
  const target = value.target
  if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
    if (Array.isArray(target.blockIndexes)) {
      return target.blockIndexes.map((index) => `block:${String(index)}`)
    }
    if (typeof target.containsText === 'string') return [`text:${target.containsText}`]
    if (typeof target.nodeType === 'string') return [`type:${target.nodeType}`]
    if (typeof target.scope === 'string') return [`scope:${target.scope}`]
  }
  if (typeof value.find === 'string') return [`text:${value.find}`]
  return [`operation:${op}`]
}

function targetsFor(operations: readonly JsonValue[]): string[] {
  const targets = [...new Set(operations.flatMap(operationTargets))]
  if (targets.length > MAX_TARGETS) {
    throw new Error(`A Docs plan may address at most ${MAX_TARGETS} targets`)
  }
  return targets
}

function boundedReadData(result: Record<string, unknown>): {
  data: JsonValue
  truncated: boolean
} {
  const sourceBlocks = Array.isArray(result.blocks) ? result.blocks : []
  const blocks = sourceBlocks.slice(0, MAX_TARGETS).map((block) => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return null
    const value = block as Record<string, unknown>
    return {
      index: typeof value.index === 'number' ? value.index : 0,
      type: typeof value.type === 'string' ? value.type : 'p',
      text: typeof value.text === 'string' ? value.text.slice(0, 2_000) : '',
    }
  })
  const text = typeof result.text === 'string' ? result.text.slice(0, 64 * 1024) : ''
  let data: JsonValue = { blocks, text }
  let truncated = sourceBlocks.length > blocks.length || result.text !== text
  while (byteLength(data) > MAX_PAYLOAD_BYTES && blocks.length > 0) {
    blocks.pop()
    truncated = true
    data = { blocks, text }
  }
  if (byteLength(data) > MAX_PAYLOAD_BYTES) {
    data = { blocks: [], text: text.slice(0, 8 * 1024) }
    truncated = true
  }
  return { data, truncated }
}

class DocsEditorAdapter implements EditorAdapter {
  readonly editorType = 'docs'
  private readonly operations = new Map<OperationId, RecordedOperation>()
  private readonly proposedContent = new Map<OperationId, ProposedContentSnapshot>()
  private readonly execute: NonNullable<DocsEditorAdapterOptions['execute']>

  constructor(private readonly options: DocsEditorAdapterOptions) {
    this.execute = options.execute ?? executeDocsCommand
  }

  capabilities() {
    return {
      editorType: this.editorType,
      commands: ['read_document', 'apply_ops', 'save_document'],
      canUndo: true,
      canSave: true,
      canExport: false,
    }
  }

  async snapshot(documentId: DocumentId): Promise<AgentDocumentSummary> {
    const document = this.options.document()
    if (document.documentId !== documentId) throw new Error(`document ${documentId} is not open`)
    return {
      documentId,
      revision: document.revision,
      title: document.title,
      summary: `Document ${document.title} is open and ready for semantic operations.`,
    }
  }

  async read(request: {
    documentId: DocumentId
    command: string
    arguments: JsonValue
  }): Promise<AgentReadResult> {
    if (request.documentId !== this.options.document().documentId) {
      return failure('DOCUMENT_NOT_FOUND', `document ${request.documentId} is not open`)
    }
    if (request.command !== 'read_document') {
      return failure('UNAVAILABLE_IN_WEB', `unsupported Docs read command: ${request.command}`)
    }
    const outcome = await this.execute(this.options.context(), 'read_document', request.arguments)
    if (!outcome.ok) return failure('READ_FAILED', outcome.error)
    const bounded = boundedReadData(outcome.result)
    return {
      ok: true,
      summary: 'Read the current document.',
      warnings: bounded.truncated
        ? [
            {
              code: 'RESULT_TRUNCATED',
              message: 'The document readout was truncated to the Agent payload limit.',
            },
          ]
        : [],
      data: bounded.data,
    }
  }

  async propose(request: EditRequest): Promise<EditPlan> {
    if (request.command !== 'apply_ops') {
      throw new Error(`unsupported Docs edit command: ${request.command}`)
    }
    const operations = operationsFrom(request)
    const targets = targetsFor(operations)
    const target = {
      sessionId: request.sessionId,
      documentId: request.documentId,
      editorType: request.editorType,
      revision: request.revision,
      operationId: request.operationId,
      clientId: request.clientId,
    }
    if (byteLength({ target, operations }) > MAX_PAYLOAD_BYTES) {
      throw new Error('A Docs plan may not exceed 256 KiB')
    }
    const editor = this.options.context().editor
    if (!editor) throw new Error('the document editor is not ready')
    const contentDocument = editor.state.doc
    const contentHash = await sha256(contentDocument.toJSON())
    const planHash = await hashPlan({ target, operations }, contentHash)
    this.proposedContent.set(target.operationId, { planHash, contentHash })
    return {
      target,
      planId: `docs-plan-${globalThis.crypto.randomUUID()}`,
      planHash,
      summary: `Apply ${String(operations.length)} document operation(s) to ${targets.join(', ')}.`,
      operations,
      warnings: [],
    }
  }

  async apply(plan: ApprovedEditPlan): Promise<AgentEditResult> {
    const existing = this.operations.get(plan.target.operationId)
    if (existing !== undefined) {
      return existing.planHash === plan.planHash
        ? existing.result
        : failure('OPERATION_ID_COLLISION', 'this operation id is already bound to another plan')
    }
    const document = this.options.document()
    if (!document.attached) return failure('DOCUMENT_DETACHED', 'the Docs browser is disconnected')
    if (document.documentId !== plan.target.documentId) {
      return failure('DOCUMENT_NOT_FOUND', `document ${plan.target.documentId} is not open`)
    }
    if (document.clientId !== plan.target.clientId) {
      return failure('WRONG_CLIENT', 'the document is open in another browser client')
    }
    if (document.revision !== plan.target.revision) {
      return failure('STALE_REVISION', 'the document changed after this plan was prepared')
    }
    const proposedContent = this.proposedContent.get(plan.target.operationId)
    if (proposedContent === undefined || proposedContent.planHash !== plan.planHash) {
      return failure('APPROVAL_INVALID', 'approval does not authorize this exact document plan')
    }
    if ((await this.matchingProposedContent(proposedContent)) === undefined) {
      this.proposedContent.delete(plan.target.operationId)
      return failure('STALE_CONTENT', 'the Docs editor changed after this plan was prepared')
    }
    if (!(await this.options.consumeApproval(plan.approvalId, plan.planHash))) {
      return failure('APPROVAL_INVALID', 'approval does not authorize this exact document plan')
    }
    if ((await hashPlan(plan, proposedContent.contentHash)) !== plan.planHash) {
      return failure('PLAN_TAMPERED', 'the approved document plan no longer matches its hash')
    }
    const current = this.options.document()
    if (!current.attached) return failure('DOCUMENT_DETACHED', 'the Docs browser is disconnected')
    if (current.documentId !== plan.target.documentId) {
      return failure('DOCUMENT_NOT_FOUND', `document ${plan.target.documentId} is not open`)
    }
    if (current.clientId !== plan.target.clientId) {
      return failure('WRONG_CLIENT', 'the document is open in another browser client')
    }
    if (current.revision !== plan.target.revision) {
      return failure('STALE_REVISION', 'the document changed after this plan was prepared')
    }
    const approvedContent = await this.matchingProposedContent(proposedContent)
    if (approvedContent === undefined || !this.hasCurrentDocument(approvedContent)) {
      this.proposedContent.delete(plan.target.operationId)
      return failure('STALE_CONTENT', 'the Docs editor changed after this plan was prepared')
    }
    const result = this.applyOnce(plan)
    this.operations.set(plan.target.operationId, { planHash: plan.planHash, result })
    this.proposedContent.delete(plan.target.operationId)
    return result
  }

  private hasCurrentDocument(document: ProseMirrorNode): boolean {
    const editor = this.options.context().editor
    return editor !== null && editor !== undefined && editor.state.doc === document
  }

  private async matchingProposedContent(
    proposed: ProposedContentSnapshot,
  ): Promise<ProseMirrorNode | undefined> {
    const editor = this.options.context().editor
    if (!editor) return undefined
    const document = editor.state.doc
    const contentHash = await sha256(document.toJSON())
    return contentHash === proposed.contentHash && this.hasCurrentDocument(document)
      ? document
      : undefined
  }

  async verify(documentId: DocumentId): Promise<VerificationResult> {
    const document = this.options.document()
    const context = this.options.context()
    if (document.documentId !== documentId || !context.editor || !context.doc) {
      return {
        passed: false,
        issues: [{ code: 'DOCUMENT_NOT_READY', message: `document ${documentId} is not ready` }],
      }
    }
    return { passed: true, issues: [] }
  }

  async undo(id: TransactionId): Promise<AgentEditResult> {
    const editor = this.options.context().editor
    if (!editor || !editor.commands.undo()) {
      return failure('ROLLBACK_FAILED', `Could not restore document transaction ${id}.`)
    }
    return {
      ok: true,
      summary: `Undid document transaction ${id}.`,
      warnings: [],
      transactionId: id,
    }
  }

  async save(documentId: DocumentId): Promise<AgentSaveResult> {
    if (documentId !== this.options.document().documentId) {
      return failure('DOCUMENT_NOT_FOUND', `document ${documentId} is not open`)
    }
    const outcome = await this.execute(this.options.context(), 'save_document', { inPlace: true })
    return outcome.ok
      ? { ok: true, summary: 'Saved the current document.', warnings: [] }
      : failure('SAVE_FAILED', outcome.error)
  }

  export(request: ExportRequest): Promise<AgentExportResult> {
    return Promise.resolve(
      failure('UNAVAILABLE_IN_WEB', `exporting ${request.format} is unavailable in Web Docs`),
    )
  }

  private async applyOnce(plan: ApprovedEditPlan): Promise<AgentEditResult> {
    const context = this.options.context()
    const editor = context.editor
    if (!editor) return failure('DOCUMENT_NOT_READY', 'the document editor is not ready')
    const before = editor.getJSON()
    const id = transactionId()
    const outcome = await this.execute(context, 'apply_ops', { ops: plan.operations })
    if (!outcome.ok) {
      editor.commands.setContent(before)
      return { ...failure('APPLY_FAILED', outcome.error), transactionId: id }
    }
    if (outcome.result.mutated !== true) {
      editor.commands.setContent(before)
      const verification = {
        passed: false,
        issues: [
          {
            code: 'NO_CHANGES',
            message: 'The approved document operations did not change the document.',
          },
        ],
      }
      return {
        ...failure('NO_CHANGES', 'The approved document operations changed nothing.'),
        verification,
        transactionId: id,
      }
    }
    const verification = await this.verify(plan.target.documentId)
    if (!verification.passed) {
      editor.commands.setContent(before)
      return {
        ...failure('ROLLED_BACK', 'Document verification failed; the transaction was rolled back.'),
        verification,
        transactionId: id,
      }
    }
    const targets = targetsFor(plan.operations)
    return {
      ok: true,
      summary: `Applied ${String(plan.operations.length)} document operation(s).`,
      changes: { targets, count: plan.operations.length },
      warnings: plan.warnings.slice(0, MAX_WARNINGS),
      verification,
      transactionId: id,
    }
  }
}

export function createDocsEditorAdapter(options: DocsEditorAdapterOptions): EditorAdapter {
  return new DocsEditorAdapter(options)
}
