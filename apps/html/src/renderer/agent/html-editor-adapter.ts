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

export interface HtmlEditorAdapterOptions {
  document(): {
    documentId: import('@nexusdesk/protocol').DocumentId
    clientId: import('@nexusdesk/protocol').ClientId
    revision: import('@nexusdesk/protocol').Revision
    contentVersion: number
    title: string
    attached: boolean
  }
  read(): AgentReadResult
  apply(operations: JsonValue[]): Promise<AgentEditResult>
  saveContent?(): string
  save(approvedSaveGuard?: () => boolean): Promise<AgentSaveResult>
  consumeApproval(id: string, hash: string): boolean | Promise<boolean>
}
const fail = (code: string, message: string): AgentEditResult => ({
  ok: false,
  summary: message,
  warnings: [{ code, message }],
})
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`
}
async function hash(
  plan: Pick<EditPlan, 'target' | 'operations'>,
  contentVersion: number,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      canonical({ target: plan.target, operations: plan.operations, contentVersion }),
    ),
  )
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('')
}
function operations(request: EditRequest): JsonValue[] {
  const value = request.arguments
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray(value.ops) ||
    value.ops.length === 0
  )
    throw new Error('apply_ops requires a non-empty ops array')
  if (value.ops.length > 200) throw new Error('An HTML plan may contain at most 200 operations')
  if (new TextEncoder().encode(JSON.stringify(value.ops)).byteLength > 256 * 1024)
    throw new Error('An HTML plan may not exceed 256 KiB')
  return value.ops as JsonValue[]
}
function targets(ops: JsonValue[]): string[] {
  return ops.map((op, index) =>
    typeof op === 'object' &&
    op !== null &&
    !Array.isArray(op) &&
    typeof (op as Record<string, unknown>).sid === 'number'
      ? `sid:${String((op as Record<string, unknown>).sid)}`
      : `operation:${String(index)}`,
  )
}

class HtmlEditorAdapter implements EditorAdapter {
  readonly editorType = 'html'
  private readonly applied = new Map<
    OperationId,
    { hash: string; result: Promise<AgentEditResult> }
  >()
  private readonly proposedContentVersions = new Map<OperationId, number>()
  constructor(private readonly options: HtmlEditorAdapterOptions) {}
  capabilities() {
    return {
      editorType: this.editorType,
      commands: ['read_html', 'apply_ops', 'save_html'],
      canUndo: true,
      canSave: true,
      canExport: false,
    }
  }
  async snapshot(documentId: import('@nexusdesk/protocol').DocumentId) {
    const document = this.options.document()
    if (document.documentId !== documentId) throw new Error('document is not open')
    return {
      documentId,
      revision: document.revision,
      title: document.title,
      summary: `HTML document ${document.title} is open.`,
    }
  }
  async read(request: {
    documentId: import('@nexusdesk/protocol').DocumentId
    command: string
    arguments: JsonValue
  }): Promise<AgentReadResult> {
    if (request.documentId !== this.options.document().documentId)
      return fail('DOCUMENT_NOT_FOUND', 'the HTML document is not open')
    return request.command === 'read_html'
      ? this.options.read()
      : fail('UNAVAILABLE_IN_WEB', `unsupported HTML read command: ${request.command}`)
  }
  async propose(request: EditRequest): Promise<EditPlan> {
    if (request.command !== 'apply_ops')
      throw new Error(`unsupported HTML edit command: ${request.command}`)
    const ops = operations(request)
    const contentVersion = this.options.document().contentVersion
    const plan: EditPlan = {
      target: {
        sessionId: request.sessionId,
        documentId: request.documentId,
        editorType: request.editorType,
        revision: request.revision,
        operationId: request.operationId,
        clientId: request.clientId,
      },
      planId: `html-plan-${crypto.randomUUID()}` as never,
      planHash: '',
      summary: `Apply ${String(ops.length)} HTML operation(s) to ${targets(ops).join(', ')}.`,
      operations: ops,
      warnings: [],
    }
    plan.planHash = await hash(plan, contentVersion)
    this.proposedContentVersions.set(plan.target.operationId, contentVersion)
    return plan
  }
  async apply(plan: ApprovedEditPlan): Promise<AgentEditResult> {
    const replay = this.applied.get(plan.target.operationId)
    if (replay)
      return replay.hash === plan.planHash
        ? replay.result
        : fail('OPERATION_ID_COLLISION', 'this operation id is already bound to another plan')
    const document = this.options.document()
    if (!document.attached) return fail('DOCUMENT_DETACHED', 'the HTML browser is disconnected')
    if (
      document.documentId !== plan.target.documentId ||
      document.clientId !== plan.target.clientId
    )
      return fail('WRONG_CLIENT', 'the HTML document is open in another browser client')
    if (document.revision !== plan.target.revision)
      return fail('STALE_REVISION', 'the document changed after this plan was prepared')
    const proposedContentVersion = this.proposedContentVersions.get(plan.target.operationId)
    if (proposedContentVersion !== document.contentVersion)
      return fail('STALE_CONTENT', 'the HTML editor changed after this plan was prepared')
    if (!(await this.options.consumeApproval(plan.approvalId, plan.planHash)))
      return fail('APPROVAL_INVALID', 'approval does not authorize this exact HTML plan')
    if ((await hash(plan, proposedContentVersion)) !== plan.planHash)
      return fail('PLAN_TAMPERED', 'the approved HTML plan no longer matches its hash')
    const current = this.options.document()
    if (!current.attached) return fail('DOCUMENT_DETACHED', 'the HTML browser is disconnected')
    if (current.documentId !== plan.target.documentId || current.clientId !== plan.target.clientId)
      return fail('WRONG_CLIENT', 'the HTML document is open in another browser client')
    if (current.revision !== plan.target.revision)
      return fail('STALE_REVISION', 'the document changed after this plan was prepared')
    if (current.contentVersion !== proposedContentVersion)
      return fail('STALE_CONTENT', 'the HTML editor changed after this plan was prepared')
    const result = this.options.apply(plan.operations).then((value) =>
      value.ok
        ? {
            ...value,
            changes: value.changes ?? {
              targets: targets(plan.operations),
              count: plan.operations.length,
            },
            verification: value.verification ?? { passed: true, issues: [] },
            transactionId: value.transactionId ?? (`html-${crypto.randomUUID()}` as never),
          }
        : value,
    )
    this.applied.set(plan.target.operationId, { hash: plan.planHash, result })
    this.proposedContentVersions.delete(plan.target.operationId)
    return result
  }
  async verify(documentId: import('@nexusdesk/protocol').DocumentId): Promise<VerificationResult> {
    return documentId === this.options.document().documentId
      ? { passed: true, issues: [] }
      : {
          passed: false,
          issues: [{ code: 'DOCUMENT_NOT_FOUND', message: 'the HTML document is not open' }],
        }
  }
  async undo(): Promise<AgentEditResult> {
    return fail('UNAVAILABLE_IN_WEB', 'undoing Agent operations is unavailable in Web HTML')
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
        : fail('DOCUMENT_NOT_FOUND', 'the HTML document is not open')
    return stale ? fail('STALE_CONTENT', 'the HTML document changed after save approval') : result
  }
  async export(): Promise<AgentEditResult> {
    return fail('UNAVAILABLE_IN_WEB', 'exporting is unavailable in Web HTML')
  }
}
export function createHtmlEditorAdapter(options: HtmlEditorAdapterOptions): EditorAdapter {
  return new HtmlEditorAdapter(options)
}
