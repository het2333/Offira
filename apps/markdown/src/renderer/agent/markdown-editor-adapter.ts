import type {
  AgentEditResult,
  AgentReadResult,
  AgentSaveResult,
  ApprovedEditPlan,
  EditPlan,
  EditRequest,
  EditorAdapter,
  JsonValue,
  OperationId,
  VerificationResult,
} from '@nexusdesk/protocol'

const MAX_OPERATIONS = 200
const MAX_PAYLOAD_BYTES = 256 * 1024

interface MarkdownDocumentState {
  documentId: import('@nexusdesk/protocol').DocumentId
  clientId: import('@nexusdesk/protocol').ClientId
  revision: import('@nexusdesk/protocol').Revision
  contentVersion: number
  title: string
  attached: boolean
}

export interface MarkdownEditorAdapterOptions {
  document(): MarkdownDocumentState
  read(): AgentReadResult
  apply(operations: JsonValue[]): Promise<AgentEditResult>
  saveContent?(): string
  save(approvedSaveGuard?: () => boolean): Promise<AgentSaveResult>
  consumeApproval(approvalId: string, planHash: string): boolean | Promise<boolean>
}

interface RecordedOperation {
  planHash: string
  result: Promise<AgentEditResult>
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

async function hashPlan(
  plan: Pick<EditPlan, 'target' | 'operations'>,
  contentVersion: number,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      canonical({ target: plan.target, operations: plan.operations, contentVersion }),
    ),
  )
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function operationsFrom(request: EditRequest): JsonValue[] {
  if (
    typeof request.arguments !== 'object' ||
    request.arguments === null ||
    Array.isArray(request.arguments) ||
    !Array.isArray(request.arguments.ops) ||
    request.arguments.ops.length === 0
  ) {
    throw new Error('apply_ops requires a non-empty ops array')
  }
  const operations = request.arguments.ops as JsonValue[]
  if (operations.length > MAX_OPERATIONS)
    throw new Error(`A Markdown plan may contain at most ${MAX_OPERATIONS} operations`)
  if (new TextEncoder().encode(JSON.stringify(operations)).byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error('A Markdown plan may not exceed 256 KiB')
  }
  return operations
}

function targetsFor(operations: JsonValue[]): string[] {
  return operations.slice(0, 200).map((operation, index) => {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      return `operation:${String(index)}`
    }
    const op = operation as Record<string, JsonValue>
    return typeof op.blockIndex === 'number'
      ? `block:${String(op.blockIndex)}`
      : `operation:${typeof op.op === 'string' ? op.op : String(index)}`
  })
}

class MarkdownEditorAdapter implements EditorAdapter {
  readonly editorType = 'markdown'
  private readonly operations = new Map<OperationId, RecordedOperation>()
  private readonly proposedContentVersions = new Map<OperationId, number>()

  constructor(private readonly options: MarkdownEditorAdapterOptions) {}

  capabilities() {
    return {
      editorType: this.editorType,
      commands: ['read_markdown', 'apply_ops', 'save_markdown'],
      canUndo: true,
      canSave: true,
      canExport: false,
    }
  }

  async snapshot(documentId: import('@nexusdesk/protocol').DocumentId) {
    const document = this.options.document()
    if (document.documentId !== documentId) throw new Error(`document ${documentId} is not open`)
    return {
      documentId,
      revision: document.revision,
      title: document.title,
      summary: `Markdown document ${document.title} is open.`,
    }
  }

  async read(request: {
    documentId: import('@nexusdesk/protocol').DocumentId
    command: string
    arguments: JsonValue
  }): Promise<AgentReadResult> {
    if (request.documentId !== this.options.document().documentId)
      return failure('DOCUMENT_NOT_FOUND', 'the requested Markdown document is not open')
    if (request.command !== 'read_markdown')
      return failure('UNAVAILABLE_IN_WEB', `unsupported Markdown read command: ${request.command}`)
    return this.options.read()
  }

  async propose(request: EditRequest): Promise<EditPlan> {
    if (request.command !== 'apply_ops')
      throw new Error(`unsupported Markdown edit command: ${request.command}`)
    const operations = operationsFrom(request)
    const contentVersion = this.options.document().contentVersion
    const target = {
      sessionId: request.sessionId,
      documentId: request.documentId,
      editorType: request.editorType,
      revision: request.revision,
      operationId: request.operationId,
      clientId: request.clientId,
    }
    const plan: EditPlan = {
      target,
      planId: `markdown-plan-${globalThis.crypto.randomUUID()}` as never,
      planHash: '',
      summary: `Apply ${String(operations.length)} Markdown operation(s) to ${targetsFor(operations).join(', ')}.`,
      operations,
      warnings: [],
    }
    plan.planHash = await hashPlan(plan, contentVersion)
    this.proposedContentVersions.set(plan.target.operationId, contentVersion)
    return plan
  }

  async apply(plan: ApprovedEditPlan): Promise<AgentEditResult> {
    const existing = this.operations.get(plan.target.operationId)
    if (existing !== undefined)
      return existing.planHash === plan.planHash
        ? existing.result
        : failure('OPERATION_ID_COLLISION', 'this operation id is already bound to another plan')
    const document = this.options.document()
    if (!document.attached)
      return failure('DOCUMENT_DETACHED', 'the Markdown browser is disconnected')
    if (
      document.documentId !== plan.target.documentId ||
      document.clientId !== plan.target.clientId
    )
      return failure('WRONG_CLIENT', 'the Markdown document is open in another browser client')
    if (document.revision !== plan.target.revision)
      return failure('STALE_REVISION', 'the document changed after this plan was prepared')
    const proposedContentVersion = this.proposedContentVersions.get(plan.target.operationId)
    if (proposedContentVersion !== document.contentVersion) {
      return failure('STALE_CONTENT', 'the Markdown editor changed after this plan was prepared')
    }
    if (!(await this.options.consumeApproval(plan.approvalId, plan.planHash)))
      return failure('APPROVAL_INVALID', 'approval does not authorize this exact Markdown plan')
    if ((await hashPlan(plan, proposedContentVersion)) !== plan.planHash)
      return failure('PLAN_TAMPERED', 'the approved Markdown plan no longer matches its hash')
    const current = this.options.document()
    if (!current.attached)
      return failure('DOCUMENT_DETACHED', 'the Markdown browser is disconnected')
    if (current.documentId !== plan.target.documentId || current.clientId !== plan.target.clientId)
      return failure('WRONG_CLIENT', 'the Markdown document is open in another browser client')
    if (current.revision !== plan.target.revision)
      return failure('STALE_REVISION', 'the document changed after this plan was prepared')
    if (current.contentVersion !== proposedContentVersion)
      return failure('STALE_CONTENT', 'the Markdown editor changed after this plan was prepared')
    const result = this.applyOnce(plan.operations)
    this.operations.set(plan.target.operationId, { planHash: plan.planHash, result })
    this.proposedContentVersions.delete(plan.target.operationId)
    return result
  }

  async verify(documentId: import('@nexusdesk/protocol').DocumentId): Promise<VerificationResult> {
    return documentId === this.options.document().documentId
      ? { passed: true, issues: [] }
      : {
          passed: false,
          issues: [{ code: 'DOCUMENT_NOT_FOUND', message: 'the Markdown document is not open' }],
        }
  }

  async undo(): Promise<AgentEditResult> {
    return failure('UNAVAILABLE_IN_WEB', 'undoing Agent operations is unavailable in Web Markdown')
  }

  saveSnapshot(): string {
    if (!this.options.saveContent) throw new Error('full save content is unavailable')
    return canonical({ document: this.options.document(), content: this.options.saveContent() })
  }

  async save(documentId: import('@nexusdesk/protocol').DocumentId): Promise<AgentSaveResult> {
    const snapshot = this.saveSnapshot()
    let stale = false
    const result =
      documentId === this.options.document().documentId
        ? await this.options.save(() => {
            stale = this.saveSnapshot() !== snapshot
            return !stale
          })
        : failure('DOCUMENT_NOT_FOUND', 'the Markdown document is not open')
    return stale
      ? failure('STALE_CONTENT', 'the Markdown document changed after save approval')
      : result
  }

  async export(): Promise<AgentEditResult> {
    return failure('UNAVAILABLE_IN_WEB', 'exporting is unavailable in Web Markdown')
  }

  private async applyOnce(operations: JsonValue[]): Promise<AgentEditResult> {
    const result = await this.options.apply(operations)
    if (!result.ok) return result
    return {
      ...result,
      changes: result.changes ?? { targets: targetsFor(operations), count: operations.length },
      verification: result.verification ?? { passed: true, issues: [] },
      transactionId:
        result.transactionId ?? (`markdown-${globalThis.crypto.randomUUID()}` as never),
    }
  }
}

export function createMarkdownEditorAdapter(options: MarkdownEditorAdapterOptions): EditorAdapter {
  return new MarkdownEditorAdapter(options)
}
