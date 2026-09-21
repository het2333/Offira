# Task 2 report: persistent isolated Office Sessions

## Status

Implemented the Task 2 binding seam without adding a second prompt driver or a generic RPC surface. The Local Host now validates an attached editor before requesting a native binding; the runtime durably maps `(hostId, documentId)` to one stable ID, creates or resumes that ID through the installed official Session APIs, and returns it without submitting a prompt.

Revision is the existing numeric branded `Revision`. Legacy `agent:start` keeps its caller-supplied Session ID and its six existing editor kinds; native binding accepts only `sheets`, `docs`, and `slides`.

## RED evidence

- `npm run test -w @nexusdesk/runtime-host -- tests/office-session-binding.test.ts`
  - failed because `../src/office-session-binding` did not exist.
- `npm run test -w @nexusdesk/local-host -- tests/harness-supervisor.test.ts tests/agent-router.test.ts`
  - 5 intended failures: `bindOfficeSession`, `bindNativeSession`, and ownership preparation did not exist.
- `npm run test -w @nexusdesk/runtime-host -- tests/operation-identity.test.ts`
  - native bind emitted no `office:bound` response.
  - concurrent binds entered `agents.create` twice for the same stable ID (3 total creates instead of 2 including setup state).
- focused Local Host request-identity test failed because an empty native request ID was accepted.
- focused resume cleanup test failed because a handle whose recovered inbox cleanup threw was not disposed.

## GREEN evidence

- Runtime Host tests: `npm run test -w @nexusdesk/runtime-host`
  - 15 files, 95 tests passed.
- Task 2 binding tests: `tests/office-session-binding.test.ts`
  - 14 tests passed, covering restart-stable mapping, Host/document isolation, concurrent binding, corrupt-map refusal, strict frozen selections, official create/resume selection, queued-inbox clearing, and fail-closed cleanup.
- Runtime IPC integration: `tests/operation-identity.test.ts`
  - 6 tests passed, including bind-without-prompt, explicit durable state directory, and coalesced concurrent acquisition.
- Local Host affected tests: `npm run test -w @nexusdesk/local-host -- tests/harness-supervisor.test.ts tests/agent-router.test.ts`
  - 2 files, 31 tests passed.
- Local Host typecheck: `npm run typecheck -w @nexusdesk/local-host`
  - passed.
- Runtime build: `npm run build -w @nexusdesk/runtime-host`
  - passed.
- `git diff --check` for Task 2 paths
  - passed.

## Interfaces for Task 3

### Selection and context

```ts
type OfficeEditorType = 'sheets' | 'docs' | 'slides'

type OfficeSelection =
  | { kind: 'sheets'; sheetId: string; a1: string | null; columns?: readonly string[] }
  | { kind: 'docs'; startIndex: number; endIndex: number; isRange: boolean; from?: number; to?: number }
  | { kind: 'slides'; slide: number; elements: readonly string[] }

interface OfficeTurnContext {
  hostId: string
  documentId: string
  editorType: OfficeEditorType
  revision: Revision
  selection: OfficeSelection
}
```

`freezeOfficeTurnContext(unknown)` validates strict keys and bounds, enforces the editor tag, copies nested arrays, and deeply freezes the accepted context. Sheets A1 ranges are bounded to 10,000 cells and Excel row/column limits; Docs positions and Slides element lists are bounded. `officeTurnContextText(context)` returns a bounded model-visible context section without exposing `hostId`.

### Runtime IPC

```ts
// Host -> runtime; does not submit a prompt
type RuntimeOfficeBindFrame = {
  type: 'office:bind'
  protocolVersion: number
  id: string
  hostId: string
  documentId: DocumentId
  clientId: ClientId
  editorType: OfficeEditorType
  revision: Revision
  cwd: string
  provider?: string
  model?: string
}

// runtime -> Host
type RuntimeOfficeBoundFrame = {
  type: 'office:bound'
  protocolVersion: number
  id: string
  sessionId: SessionId
  resumed: boolean
}
```

`HarnessSupervisor.bindOfficeSession(input)` returns `Promise<{ sessionId, resumed }>` and rejects pending binds if the child exits. The runtime sets the editor target before acquiring the official Session, uses `sessionPersistence.stat(id)`, calls `agents.resume({ resumeSessionId, agentOptions, setup })` only when the Session exists, and calls `agents.create(...)` only on `stat(...) === undefined`. Stat, corruption, ownership, and resume errors never fall through to create.

On resume, the installed agent loop reconstructs durable inbox splices but does not automatically wake them. Task 2 clears any recovered `next-turn`/`next-step` inbox before returning the binding so a later native prompt cannot drive an old queued prompt or tool sequence. Inbox cleanup failure disposes the acquired handle and rejects the bind.

### Local Host ownership and prompt preparation

```ts
AgentRouter.bindNativeSession({
  hostId, documentId, clientId, cwd, provider?, model?
}): Promise<SessionId>

AgentRouter.assertNativeSessionOwner(
  sessionId: SessionId,
  clientId: ClientId,
): { hostId: string; documentId: DocumentId; clientId: ClientId }

AgentRouter.prepareNativeTurn({
  requestId, sessionId, clientId, selection
}): {
  requestId: string
  sessionId: SessionId
  context: OfficeTurnContext
  contextText: string
}
```

`bindNativeSession` calls `DocumentRegistry.assertClient` and derives `editorType` and current numeric `revision` from the registered Host document; it records router ownership only after the runtime acknowledges the binding. `prepareNativeTurn` revalidates the exact native owner and live document registration/revision, then freezes selection. Task 3 must await `bindNativeSession` immediately before its official prompt call (this also refreshes runtime target identity/revision), call `prepareNativeTurn`, prepend `contextText` to the original official Session Controller prompt envelope keyed by the original `requestId`, and invoke the official gateway exactly once. It must preserve optimistic echo and model selection. There is intentionally no `office:prompt` IPC or `agent.followup` native path.

Production Host passes `--state-dir=<NexusDesk application-data>/harness-runtime`; the runtime does not install a deletion exit hook for an explicit directory. Invocations without that option, including smoke/tests, continue to use an isolated temporary `DSH_HOME` that is removed on exit.

## Changed files

- `.superpowers/sdd/2026-09-21-harness-office-panel/task-2-report.md`
- `packages/nexusdesk-runtime-host/src/office-session-binding.ts`
- `packages/nexusdesk-runtime-host/src/protocol.ts`
- `packages/nexusdesk-runtime-host/src/index.ts`
- `packages/nexusdesk-runtime-host/tests/office-session-binding.test.ts`
- `packages/nexusdesk-runtime-host/tests/operation-identity.test.ts`
- `packages/nexusdesk-runtime-host/package.json`
- `packages/nexusdesk-runtime-host/lib/index.mjs` (generated build)
- `apps/local-host/src/harness-supervisor.ts`
- `apps/local-host/src/agent-router.ts`
- `apps/local-host/src/main.ts` (Task 2 hunk only: explicit runtime state directory)
- `apps/local-host/tests/harness-supervisor.test.ts`
- `apps/local-host/tests/agent-router.test.ts`
- `apps/local-host/tests/fixtures/fake-runtime.mjs`

No Sheets or `sheets-tools` files were changed by Task 2.

## Known gaps / concurrent blockers

- Runtime typecheck passed before concurrent Task 3 gateway-channel tests arrived. The current full command is blocked only by `tests/office-gateway-channel.test.ts:46,69` (`TS2554: Expected 1 arguments, but got 0`), outside Task 2 ownership; Task 2 sources have no reported type errors.
- Production smoke reaches the complete tool sequence, then fails an existing stale assertion in `tests/runtime-smoke.mjs`: it expects `operation-smoke-*-call`, while committed operation identity code since `d3cb3b0` uses document/editor/tool/call SHA-256 IDs. The smoke also predates later save-contract changes. Task 2 did not change that test or the operation-ID algorithm. Runtime build succeeds and the runtime test suite is green.
- Task 3 still owns the authenticated official gateway carrier and event filtering. Task 2 deliberately does not expose a generic Harness RPC proxy or activate UI.
