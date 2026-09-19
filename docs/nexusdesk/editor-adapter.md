# NexusDesk editor adapter contract

An editor adapter is the stable boundary between a Harness-native Tool and a
GenOffice editor. Harness sees curated capabilities and Agent-facing results;
it never receives Univer, ProseMirror, Electron, or other engine-owned objects.

The public types live in `@nexusdesk/protocol`. Browser connection and editor
registration helpers live in `@nexusdesk/web-client`. Sheets is the reference
implementation in `apps/sheets/src/renderer/agent/sheets-adapter.ts`.

This boundary is downstream of the
[Office Host contract](office-host-contract.md). `OfficeHost` owns Shell state
and product capabilities; `EditorAdapter` owns semantic read, propose, apply,
verify, and save behavior inside one isolated editor bundle. Neither layer
exposes the editor engine to Harness.

## Identity and authority

Every mutating request carries one `MutationTarget`:

```ts
interface MutationTarget {
  sessionId: SessionId
  documentId: DocumentId
  editorType: string
  revision: Revision
  operationId: OperationId
  clientId: ClientId
}
```

The fields have separate purposes:

- `sessionId` binds the request to one Harness agent turn.
- `documentId` names the host-owned document, never a filesystem path.
- `editorType` selects the adapter and command family.
- `revision` is the optimistic-concurrency version accepted before dispatch.
- `operationId` is the host-lifetime idempotency key for the semantic operation.
- `clientId` binds the request to the authenticated browser connection.

The Local Host, not Harness or the iframe, is the authority. It verifies the
session owner, client, document, editor type, and current revision before an
operation reaches the editor. The browser must return the exact request ID and
target it received.

## Lifecycle frames

All frames carry `protocolVersion: 1` and are JSON text frames.

1. The host sends `server:ready` with a connection-scoped `clientId`.
2. `registerEditor` sends `editor:register` with document, editor type, and
   current revision. It re-registers automatically after reconnect.
3. The browser sends `agent:start`; the host supplies its authoritative client
   and revision when opening the Harness turn.
4. Harness may emit streaming `agent:event` frames and an `approval:request`.
5. After `approval:response`, a native Tool sends `editor:request` to the exact
   owning client.
6. A successful mutation advances the editor revision with `editor:revision`
   and returns `editor:result`. The revision notification can precede the
   result for the operation authorized at the previous revision.
7. `dispose()` sends `editor:detach` when connected. A socket loss also detaches
   the client and cancels its active turns and approvals.

Only `editor:register` and `operation:lookup` are safe to queue while the socket
is reconnecting. New mutations, approvals, and results fail closed while
disconnected.

## Proposal, approval, apply, and verify

A mutating command follows this sequence:

```text
Tool command
  -> adapter.propose(EditRequest)
  -> immutable operation list + planHash
  -> one-shot approval bound to that hash
  -> adapter.apply(ApprovedEditPlan)
  -> editor transaction
  -> adapter verification
  -> rollback on verification failure, otherwise commit revision
  -> AgentToolResult
```

`propose` validates and normalizes the editor DSL before approval. `apply` must
recompute or verify `planHash` and consume the approval exactly once; a changed
plan is rejected. A multi-operation edit is one transaction. Failed
post-apply verification rolls that transaction back and returns a structured
failure rather than throwing an engine object across the boundary.

Read operations may include JSON-safe `data`. Mutation, save, and export
results use the stricter `AgentToolResult` envelope:

```ts
interface AgentToolResult {
  ok: boolean
  summary: string
  changes?: { targets: string[]; count: number }
  warnings: Array<{ code: string; message: string; target?: string }>
  verification?: {
    passed: boolean
    issues: Array<{ code: string; message: string; target?: string }>
  }
  continuation?: { suggestedTool?: string; reason?: string }
  transactionId?: TransactionId
}
```

Return summaries, stable target identifiers, counts, warnings, and verification
issues useful to an Agent. Never return editor instances, DOM nodes, native
handles, IPC response objects, filesystem paths not needed by the Agent, or
arbitrary compatibility payloads. Use `parseAgentToolResult` in adapter tests
to enforce this boundary.

## Idempotency and reconnects

The Local Host reserves `operationId` against the stable semantic fingerprint:

```text
documentId + editorType + command + arguments
```

Connection-scoped `sessionId`, `clientId`, and `revision` are deliberately not
part of that fingerprint. Retrying an identical operation after reconnect
replays its committed or failed result without applying the edit again. Reusing
an operation ID with different semantics is a collision and is rejected.

Ownership and the current revision are still checked for every newly received
request before the operation journal is consulted. This prevents idempotency
from becoming an authorization bypass.

Keep the adapter's own in-flight map as a second guard: the same operation ID
and plan hash return the same promise; a different plan hash fails.

## Limits and failure behavior

- WebSocket messages are limited to 1 MiB and binary frames are rejected.
- HTTP JSON request bodies are limited to 2 MB.
- Unknown protocol versions and malformed frames fail closed.
- Approval requests expire after 120 seconds by default and are invalidated by
  a document revision change, disconnect, or runtime exit.
- A Harness crash ends affected turns with a fatal frame. Interrupted turns are
  not replayed automatically; the supervisor restarts the runtime for new work.
- Adapter methods must convert expected editor failures to `AgentToolResult`.
  Throw only for programmer errors or boundaries that the browser bridge will
  convert to `EDITOR_REQUEST_FAILED`.

## Minimal adapter

This complete adapter uses the real exported protocol names. It intentionally
stores plain JSON state so the boundary is visible; a production adapter maps
the same methods to its editor DSL and transaction engine.

```ts
import {
  type AgentDocumentSummary,
  type AgentEditResult,
  type AgentExportResult,
  type AgentReadResult,
  type AgentSaveResult,
  type ApprovedEditPlan,
  type DocumentId,
  type EditPlan,
  type EditRequest,
  type EditorAdapter,
  type EditorCapabilities,
  type ExportRequest,
  type JsonValue,
  type ReadRequest,
  type Revision,
  type TransactionId,
  type VerificationResult,
} from '@nexusdesk/protocol'

export class NotesAdapter implements EditorAdapter {
  readonly editorType = 'notes'
  private revision = 1 as Revision
  private readonly applied = new Map<
    string,
    { planHash: string; result: Promise<AgentEditResult> }
  >()

  constructor(
    private readonly documentId: DocumentId,
    private title: string,
    private readonly consumeApproval: (
      approvalId: string,
      planHash: string,
    ) => boolean | Promise<boolean>,
    private text = '',
  ) {}

  capabilities(): EditorCapabilities {
    return {
      editorType: this.editorType,
      commands: ['read_notes', 'replace_text'],
      canUndo: false,
      canSave: true,
      canExport: false,
    }
  }

  async snapshot(documentId: DocumentId): Promise<AgentDocumentSummary> {
    this.assertDocument(documentId)
    return {
      documentId,
      revision: this.revision,
      title: this.title,
      summary: `${this.text.length} characters`,
    }
  }

  async read(request: ReadRequest): Promise<AgentReadResult> {
    this.assertDocument(request.documentId)
    return { ok: true, summary: 'Read notes.', warnings: [], data: { text: this.text } }
  }

  async propose(request: EditRequest): Promise<EditPlan> {
    this.assertDocument(request.documentId)
    if (request.command !== 'replace_text') throw new Error('unsupported command')
    if (request.revision !== this.revision) throw new Error('stale document revision')
    const args = request.arguments as { text?: JsonValue }
    if (typeof args.text !== 'string') throw new Error('text must be a string')
    const operations = [{ text: args.text }]
    return {
      target: request,
      planId: `plan-${request.operationId}`,
      planHash: await hashJson({ target: request, operations }),
      summary: 'Replace the note text.',
      operations,
      warnings: [],
    }
  }

  async apply(plan: ApprovedEditPlan): Promise<AgentEditResult> {
    const key = plan.target.operationId
    const existing = this.applied.get(key)
    if (existing !== undefined) {
      return existing.planHash === plan.planHash
        ? existing.result
        : failure('OPERATION_ID_COLLISION', 'The operation ID belongs to another plan.')
    }
    const result = this.applyOnce(plan)
    this.applied.set(key, { planHash: plan.planHash, result })
    return result
  }

  private async applyOnce(plan: ApprovedEditPlan): Promise<AgentEditResult> {
    this.assertDocument(plan.target.documentId)
    if (plan.target.revision !== this.revision) {
      return failure('REVISION_CONFLICT', 'The note changed after this plan was proposed.')
    }
    const expectedHash = await hashJson({
      target: plan.target,
      operations: plan.operations,
    })
    if (expectedHash !== plan.planHash) {
      return failure('PLAN_TAMPERED', 'The approved plan payload changed.')
    }
    if (!(await this.consumeApproval(plan.approvalId, plan.planHash))) {
      return failure('APPROVAL_REQUIRED', 'This exact plan was not approved.')
    }
    const operation = plan.operations[0] as { text?: JsonValue } | undefined
    if (typeof operation?.text !== 'string') {
      return failure('INVALID_PLAN', 'The approved plan is invalid.')
    }
    this.text = operation.text
    this.revision = (Number(this.revision) + 1) as Revision
    return {
      ok: true,
      summary: 'Replaced the note text.',
      changes: { targets: ['document:text'], count: 1 },
      warnings: [],
      verification: { passed: true, issues: [] },
      transactionId: `notes-${plan.target.operationId}` as TransactionId,
    }
  }

  async verify(documentId: DocumentId): Promise<VerificationResult> {
    this.assertDocument(documentId)
    return { passed: true, issues: [] }
  }

  async undo(_transactionId: TransactionId): Promise<AgentEditResult> {
    return failure('UNDO_UNAVAILABLE', 'This adapter does not support undo.')
  }

  async save(documentId: DocumentId): Promise<AgentSaveResult> {
    this.assertDocument(documentId)
    return { ok: true, summary: 'Saved notes.', warnings: [] }
  }

  async export(request: ExportRequest): Promise<AgentExportResult> {
    this.assertDocument(request.documentId)
    return failure('EXPORT_UNAVAILABLE', 'This adapter does not support export.')
  }

  private assertDocument(documentId: DocumentId): void {
    if (documentId !== this.documentId) throw new Error(`document ${documentId} is not open`)
  }
}

function failure(code: string, message: string): AgentEditResult {
  return { ok: false, summary: message, warnings: [{ code, message }] }
}

async function hashJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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
```

The one-field assignment cannot partially fail, so the example needs no
rollback implementation. Real multi-operation adapters must wrap apply and
verification in an editor transaction and copy the rollback pattern from
`createSheetsAdapter`.

## Adding Docs or Slides

1. Preserve the editor's existing operation DSL; expose curated commands rather
   than one Tool per engine method.
2. Add missing user-visible editing capabilities to that DSL first.
3. Implement `EditorAdapter` without importing Harness packages into the
   editor. Harness dependencies stay in `packages/nexusdesk-runtime-host`.
4. Register native Tools in the runtime and route them through the versioned
   protocol. Do not add MCP as the product bridge.
5. Test validation, approval binding, rollback, Agent result projection,
   revision conflicts, reconnect replay, and saved-file reopening.
6. Add a keyless Chromium acceptance test whose oracle is the saved native
   file, not assistant prose.

Docs and Slides integration must preserve their current operation DSLs and add
missing user-visible editing operations there before registration as native
Tools. They require their own plans, adapter tests, routes, saved-file oracles,
and recovery acceptance flows; Sheets support does not imply those editors are
already available in the NexusDesk Web product.
