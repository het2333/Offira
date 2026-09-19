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
  Revision,
  TransactionId,
  VerificationResult,
} from '@nexusdesk/protocol'

const MAX_OPERATIONS = 50
const MAX_PAYLOAD_BYTES = 256 * 1024

export interface SlidesDocumentState {
  documentId: DocumentId
  clientId: ClientId
  revision: Revision
  /** Monotonic in-memory deck version; unlike disk revision, it advances for unsaved edits. */
  contentVersion: number
  title: string
  attached: boolean
}

export interface SlidesEditorAdapterOptions {
  document(): SlidesDocumentState
  read(): Promise<JsonValue>
  runTransaction(operations: JsonValue[]): Promise<{ applied: boolean; contentVersion?: number; records?: Array<{ op: string; target?: string }>; failures?: Array<{ error: string }> }>
  save(): Promise<void>
  undo(): Promise<{ contentVersion: number } | null>
  redo(): Promise<{ contentVersion: number } | null>
  consumeApproval(approvalId: string, planHash: string): boolean | Promise<boolean>
}

export interface SlidesSavePlan {
  planHash: string
  contentVersion: number
  summary: string
  targets: string[]
  warnings: Array<{ code: string; message: string; target?: string }>
}

export type SlidesHistoryAction = 'undo' | 'redo'

export interface SlidesHistoryPlan extends EditPlan<{ action: SlidesHistoryAction }> {
  contentVersion: number
}

export interface ApprovedSlidesHistoryPlan extends SlidesHistoryPlan {
  approvalId: string
}

export interface SlidesEditorAdapter extends EditorAdapter {
  proposeSave(request: EditRequest): Promise<SlidesSavePlan>
  proposeHistory(request: EditRequest): Promise<SlidesHistoryPlan>
  applyHistory(plan: ApprovedSlidesHistoryPlan): Promise<AgentEditResult>
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

async function hash(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function failure(code: string, message: string): AgentEditResult {
  return { ok: false, summary: message, warnings: [{ code, message }] }
}

function operations(request: EditRequest): JsonValue[] {
  if (typeof request.arguments !== 'object' || request.arguments === null || Array.isArray(request.arguments)) throw new Error('Presentation operations must be an object')
  const value = request.arguments.ops
  if (!Array.isArray(value) || value.length === 0) throw new Error('apply_ops requires a non-empty ops array')
  if (value.length > MAX_OPERATIONS) throw new Error(`A presentation plan may contain at most ${MAX_OPERATIONS} operations`)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PAYLOAD_BYTES) throw new Error('A presentation plan may not exceed 256 KiB')
  for (const operation of value) {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) throw new Error('Each presentation operation must be an object')
  }
  return value
}

function targets(ops: JsonValue[]): string[] {
  return ops.map((operation) => {
    const value = operation as Record<string, JsonValue>
    const target = value.target
    if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
      const slide = typeof target.slide === 'number' ? `slide:${String(target.slide + 1)}` : 'presentation'
      return typeof target.el === 'string' ? `${slide}/${target.el}` : slide
    }
    return typeof value.op === 'string' ? `operation:${value.op}` : 'presentation'
  })
}

function sameTarget(left: EditPlan, right: SlidesDocumentState): boolean {
  return left.target.documentId === right.documentId && left.target.clientId === right.clientId && left.target.revision === right.revision && left.target.editorType === 'slides'
}

function sameRequestTarget(request: EditRequest, current: SlidesDocumentState): boolean {
  return request.documentId === current.documentId && request.clientId === current.clientId && request.revision === current.revision && request.editorType === 'slides'
}

function historyAction(value: JsonValue): SlidesHistoryAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || (value.action !== 'undo' && value.action !== 'redo')) {
    throw new Error('Presentation history requests require action "undo" or "redo"')
  }
  return value.action
}

export function createSlidesEditorAdapter(options: SlidesEditorAdapterOptions): SlidesEditorAdapter {
  const applied = new Map<string, Promise<AgentEditResult>>()
  const proposedContentVersions = new Map<string, { planHash: string; contentVersion: number }>()
  const appliedHistory = new Map<string, Promise<AgentEditResult>>()
  const proposedHistory = new Map<string, SlidesHistoryPlan>()
  return {
    editorType: 'slides',
    capabilities: () => ({ editorType: 'slides', commands: ['read_presentation', 'apply_ops', 'save_presentation', 'undo_presentation', 'redo_presentation'], canUndo: true, canSave: true, canExport: false }),
    async snapshot(documentId): Promise<AgentDocumentSummary> {
      const current = options.document()
      if (documentId !== current.documentId) throw new Error('Presentation is not attached')
      return { documentId, revision: current.revision, title: current.title, summary: 'Open presentation' }
    },
    async read(request): Promise<AgentReadResult> {
      const current = options.document()
      if (request.documentId !== current.documentId || request.command !== 'read_presentation') return failure('INVALID_REQUEST', 'This presentation read request is not supported.')
      return { ok: true, summary: 'Read the current presentation.', warnings: [], data: await options.read() }
    },
    async propose(request): Promise<EditPlan> {
      const current = options.document()
      if (request.command !== 'apply_ops') throw new Error('Presentation editor supports only apply_ops proposals')
      if (!sameRequestTarget(request, current) || !current.attached) throw new Error('Presentation is no longer attached at the requested revision')
      const ops = operations(request)
      const planHash = await hash({ target: { documentId: request.documentId, clientId: request.clientId, revision: request.revision, editorType: request.editorType }, contentVersion: current.contentVersion, operations: ops })
      proposedContentVersions.set(request.operationId, { planHash, contentVersion: current.contentVersion })
      return { target: { sessionId: request.sessionId, documentId: request.documentId, clientId: request.clientId, editorType: 'slides', revision: request.revision, operationId: request.operationId }, planId: `slides-${request.operationId}`, planHash, summary: `Apply ${String(ops.length)} presentation operation${ops.length === 1 ? '' : 's'}.`, operations: ops, warnings: [] }
    },
    async proposeSave(request): Promise<SlidesSavePlan> {
      const current = options.document()
      if (!sameRequestTarget(request, current) || !current.attached) {
        throw new Error('Presentation is no longer attached at the requested revision')
      }
      const planHash = await hash({
        target: {
          documentId: request.documentId,
          clientId: request.clientId,
          revision: request.revision,
          editorType: request.editorType,
        },
        contentVersion: current.contentVersion,
        command: 'save_presentation',
      })
      return {
        planHash,
        contentVersion: current.contentVersion,
        summary: 'Save the current presentation in place.',
        targets: ['current presentation'],
        warnings: [],
      }
    },
    async proposeHistory(request): Promise<SlidesHistoryPlan> {
      const current = options.document()
      if (request.command !== 'propose_history' || !sameRequestTarget(request, current) || !current.attached) {
        throw new Error('Presentation is no longer attached at the requested revision')
      }
      const action = historyAction(request.arguments)
      const planHash = await hash({
        target: {
          documentId: request.documentId,
          clientId: request.clientId,
          revision: request.revision,
          editorType: request.editorType,
        },
        contentVersion: current.contentVersion,
        command: 'apply_history',
        action,
      })
      const plan: SlidesHistoryPlan = {
        target: { sessionId: request.sessionId, documentId: request.documentId, clientId: request.clientId, editorType: 'slides', revision: request.revision, operationId: request.operationId },
        planId: `slides-history-${request.operationId}`,
        planHash,
        summary: `${action === 'undo' ? 'Undo' : 'Redo'} the latest presentation change.`,
        operations: [{ action }],
        warnings: [],
        contentVersion: current.contentVersion,
      }
      proposedHistory.set(request.operationId, plan)
      return plan
    },
    async apply(plan: ApprovedEditPlan): Promise<AgentEditResult> {
      const current = options.document()
      if (!sameTarget(plan, current)) return failure('STALE_REVISION', 'The presentation changed or detached before this approved operation could apply.')
      const proposed = proposedContentVersions.get(plan.target.operationId)
      if (proposed === undefined || proposed.planHash !== plan.planHash || proposed.contentVersion !== current.contentVersion) {
        return failure('STALE_CONTENT', 'The presentation changed in memory after this plan was prepared.')
      }
      const actualHash = await hash({ target: { documentId: plan.target.documentId, clientId: plan.target.clientId, revision: plan.target.revision, editorType: plan.target.editorType }, contentVersion: proposed.contentVersion, operations: plan.operations })
      if (actualHash !== plan.planHash) return failure('PLAN_TAMPERED', 'The approved presentation plan no longer matches its operations.')
      const existing = applied.get(plan.target.operationId)
      if (existing !== undefined) return existing
      if (!(await options.consumeApproval(plan.approvalId, plan.planHash))) return failure('APPROVAL_INVALID', 'The presentation operation was not approved for this exact plan.')
      const result = (async () => {
        const transaction = await options.runTransaction(plan.operations)
        if (!transaction.applied) return failure('TRANSACTION_FAILED', transaction.failures?.map((failure) => failure.error).join('; ') || 'The presentation transaction made no changes.')
        const changed = transaction.records?.length ?? plan.operations.length
        return {
          ok: true,
          summary: `Applied ${String(changed)} presentation operation${changed === 1 ? '' : 's'}.`,
          changes: { targets: targets(plan.operations), count: changed },
          warnings: [],
          verification: { passed: true, issues: [] },
          transactionId: `slides-${plan.target.operationId}` as TransactionId,
          ...(transaction.contentVersion === undefined ? {} : { data: { contentVersion: transaction.contentVersion } }),
        }
      })()
      applied.set(plan.target.operationId, result)
      return result
    },
    async applyHistory(plan): Promise<AgentEditResult> {
      const current = options.document()
      if (!sameTarget(plan, current)) return failure('STALE_REVISION', 'The presentation changed or detached before this approved history change could apply.')
      const proposed = proposedHistory.get(plan.target.operationId)
      if (proposed === undefined || proposed.planHash !== plan.planHash || proposed.contentVersion !== current.contentVersion) {
        return failure('STALE_CONTENT', 'The presentation changed in memory after this history change was prepared.')
      }
      const operation = plan.operations[0]
      if (plan.operations.length !== 1 || operation === undefined || operation.action !== proposed.operations[0]!.action) {
        return failure('PLAN_TAMPERED', 'The approved presentation history change no longer matches its proposal.')
      }
      const existing = appliedHistory.get(plan.target.operationId)
      if (existing !== undefined) return existing
      if (!(await options.consumeApproval(plan.approvalId, plan.planHash))) return failure('APPROVAL_INVALID', 'The presentation history change was not approved for this exact plan.')
      const result = (async () => {
        const action = operation.action
        const history = await (action === 'undo' ? options.undo() : options.redo())
        if (history === null) return failure('HISTORY_EMPTY', `There is no presentation change to ${action}.`)
        return {
          ok: true,
          summary: `${action === 'undo' ? 'Undid' : 'Redid'} the latest presentation change.`,
          changes: { targets: ['presentation history'], count: 1 },
          warnings: [],
          verification: { passed: true, issues: [] },
          transactionId: `slides-history-${plan.target.operationId}` as TransactionId,
          data: { contentVersion: history.contentVersion },
        }
      })()
      appliedHistory.set(plan.target.operationId, result)
      return result
    },
    async verify(documentId): Promise<VerificationResult> {
      const current = options.document()
      return documentId === current.documentId && current.attached ? { passed: true, issues: [] } : { passed: false, issues: [{ code: 'DOCUMENT_DETACHED', message: 'The presentation is no longer attached.' }] }
    },
    async undo(_transactionId): Promise<AgentEditResult> { return failure('UNSUPPORTED_CAPABILITY', 'Undo is not exposed through the presentation Agent surface.') },
    async save(documentId, expectedContentVersion?: number): Promise<AgentSaveResult> {
      const current = options.document()
      if (documentId !== current.documentId || !current.attached) return failure('DOCUMENT_DETACHED', 'The presentation is no longer attached.')
      if (expectedContentVersion !== undefined && expectedContentVersion !== current.contentVersion) {
        return failure('STALE_CONTENT', 'The presentation changed in memory after this save was approved.')
      }
      await options.save()
      return { ok: true, summary: 'Saved the current presentation in place.', warnings: [] }
    },
    async export(_request: ExportRequest): Promise<AgentExportResult> { return failure('UNSUPPORTED_CAPABILITY', 'Presentation export is not exposed through the Agent surface.') },
  }
}
