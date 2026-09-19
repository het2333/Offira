import type {
  AgentDocumentSummary,
  AgentEditResult,
  AgentExportResult,
  AgentReadResult,
  AgentSaveResult,
  AgentToolResult,
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
import type { WorkbookOperation } from '@genoffice/xlsx-gateway/domain/workbook-dsl'

import {
  executeSheetsCommand,
  operationTargets,
  prepareSheetsOperations,
  type McpSheetHandlers,
} from './sheets-command'

export interface SheetsDocumentState {
  documentId: DocumentId
  clientId: ClientId
  revision: Revision
  title: string
  attached: boolean
}

export interface SheetsAdapterOptions {
  handlers: McpSheetHandlers
  document(): SheetsDocumentState
  consumeApproval(approvalId: string, planHash: string): boolean | Promise<boolean>
  verify(operations: readonly WorkbookOperation[]): Promise<VerificationResult>
  rollback(transactionId: TransactionId): Promise<void>
  commitRevision(transactionId: TransactionId): void | Promise<void>
}

interface RecordedOperation {
  planHash: string
  result: Promise<AgentEditResult>
}

function failure(code: string, message: string): AgentEditResult {
  return { ok: false, summary: message, warnings: [{ code, message }] }
}

function agentResult(result: AgentReadResult): AgentToolResult {
  const { data: _transportDetail, ...projected } = result
  return projected
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

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function transactionId(): TransactionId {
  return `sheets-${globalThis.crypto.randomUUID()}` as TransactionId
}

function operationsOf(plan: EditPlan): WorkbookOperation[] {
  return plan.operations as unknown as WorkbookOperation[]
}

async function hashPlan(plan: Pick<EditPlan, 'target' | 'operations'>): Promise<string> {
  return sha256({ target: plan.target, operations: plan.operations })
}

function outcomeFailure(outcome: unknown): string | undefined {
  if (typeof outcome !== 'object' || outcome === null) return undefined
  const record = outcome as { ok?: unknown; reason?: unknown; error?: unknown }
  if (record.ok !== false) return undefined
  return typeof record.reason === 'string'
    ? record.reason
    : typeof record.error === 'string'
      ? record.error
      : 'the spreadsheet batch failed'
}

class SheetsAdapter implements EditorAdapter {
  readonly editorType = 'sheets'
  private readonly operations = new Map<OperationId, RecordedOperation>()

  constructor(private readonly options: SheetsAdapterOptions) {}

  capabilities() {
    return {
      editorType: this.editorType,
      commands: ['read_sheet', 'apply_ops', 'save_sheet'],
      canUndo: true,
      canSave: true,
      canExport: true,
    }
  }

  async snapshot(documentId: DocumentId): Promise<AgentDocumentSummary> {
    const document = this.options.document()
    if (document.documentId !== documentId) throw new Error(`document ${documentId} is not open`)
    return {
      documentId,
      revision: document.revision,
      title: document.title,
      summary: `Spreadsheet ${document.title} is open and ready for semantic operations.`,
    }
  }

  read(request: {
    documentId: DocumentId
    command: string
    arguments: JsonValue
  }): Promise<AgentReadResult> {
    if (request.documentId !== this.options.document().documentId) {
      return Promise.resolve({
        ok: false,
        summary: `document ${request.documentId} is not open`,
        warnings: [
          { code: 'DOCUMENT_NOT_FOUND', message: `document ${request.documentId} is not open` },
        ],
      })
    }
    return executeSheetsCommand(this.options.handlers, {
      command: request.command,
      arguments: request.arguments as Record<string, unknown>,
    })
  }

  async propose(request: EditRequest): Promise<EditPlan> {
    if (request.command !== 'apply_ops')
      throw new Error(`unsupported Sheets edit command: ${request.command}`)
    const args = request.arguments as Record<string, unknown>
    const operations = prepareSheetsOperations(this.options.handlers, args.ops)
    const target = {
      sessionId: request.sessionId,
      documentId: request.documentId,
      editorType: request.editorType,
      revision: request.revision,
      operationId: request.operationId,
      clientId: request.clientId,
    }
    const jsonOperations = operations as unknown as JsonValue[]
    const planHash = await hashPlan({ target, operations: jsonOperations })
    return {
      target,
      planId: `sheets-plan-${globalThis.crypto.randomUUID()}`,
      planHash,
      summary: `Apply ${String(operations.length)} spreadsheet operation(s) to ${operationTargets(this.options.handlers, operations).join(', ')}.`,
      operations: jsonOperations,
      warnings: [],
    }
  }

  async apply(plan: ApprovedEditPlan): Promise<AgentEditResult> {
    const computedHash = await hashPlan(plan)
    if (computedHash !== plan.planHash) {
      return failure('PLAN_TAMPERED', 'the approved spreadsheet plan no longer matches its hash')
    }
    const existing = this.operations.get(plan.target.operationId)
    if (existing !== undefined) {
      return existing.planHash === plan.planHash
        ? existing.result
        : failure('OPERATION_ID_COLLISION', 'this operation id is already bound to another plan')
    }
    const result = this.applyOnce(plan)
    this.operations.set(plan.target.operationId, { planHash: plan.planHash, result })
    return result
  }

  verify(_documentId: DocumentId): Promise<VerificationResult> {
    return this.options.verify([])
  }

  async undo(id: TransactionId): Promise<AgentEditResult> {
    await this.options.rollback(id)
    return {
      ok: true,
      summary: `Undid spreadsheet transaction ${id}.`,
      warnings: [],
      transactionId: id,
    }
  }

  async save(documentId: DocumentId): Promise<AgentSaveResult> {
    if (documentId !== this.options.document().documentId) {
      return failure('DOCUMENT_NOT_FOUND', `document ${documentId} is not open`)
    }
    return agentResult(
      await executeSheetsCommand(this.options.handlers, {
        command: 'save_sheet',
        arguments: { inPlace: true },
      }),
    )
  }

  async export(request: ExportRequest): Promise<AgentExportResult> {
    if (request.format !== 'xlsx')
      return failure('UNSUPPORTED_EXPORT', `unsupported export format: ${request.format}`)
    return agentResult(
      await executeSheetsCommand(this.options.handlers, {
        command: 'save_sheet',
        arguments: { path: request.destination, overwrite: true },
      }),
    )
  }

  private async applyOnce(plan: ApprovedEditPlan): Promise<AgentEditResult> {
    const document = this.options.document()
    if (!document.attached)
      return failure('DOCUMENT_DETACHED', 'the spreadsheet browser is disconnected')
    if (document.documentId !== plan.target.documentId) {
      return failure('DOCUMENT_NOT_FOUND', `document ${plan.target.documentId} is not open`)
    }
    if (document.clientId !== plan.target.clientId) {
      return failure('WRONG_CLIENT', 'the spreadsheet is open in another browser client')
    }
    if (document.revision !== plan.target.revision) {
      return failure('STALE_REVISION', 'the spreadsheet changed after this plan was prepared')
    }
    if (!(await this.options.consumeApproval(plan.approvalId, plan.planHash))) {
      return failure('APPROVAL_INVALID', 'approval does not authorize this exact spreadsheet plan')
    }

    const id = transactionId()
    const operations = operationsOf(plan)
    const outcome = await this.options.handlers.applyOps(operations, false)
    const applyError = outcomeFailure(outcome)
    if (applyError !== undefined) return failure('APPLY_FAILED', applyError)

    const verification = await this.options.verify(operations)
    if (!verification.passed) {
      await this.options.rollback(id)
      return {
        ok: false,
        summary: 'Spreadsheet verification failed; the transaction was rolled back.',
        warnings: [
          {
            code: 'ROLLED_BACK',
            message: 'The spreadsheet batch was rolled back after verification failed.',
          },
        ],
        verification,
        transactionId: id,
      }
    }

    await this.options.commitRevision(id)
    return {
      ok: true,
      summary: `Applied ${String(operations.length)} spreadsheet operation(s).`,
      changes: {
        targets: operationTargets(this.options.handlers, operations),
        count: operations.length,
      },
      warnings: [],
      verification,
      transactionId: id,
    }
  }
}

export function createSheetsAdapter(options: SheetsAdapterOptions): EditorAdapter {
  return new SheetsAdapter(options)
}
