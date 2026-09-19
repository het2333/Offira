# NexusDesk Local Web Sheets Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a secure, browser-openable local NexusDesk application in which a DeepSeek Harness session can read, propose, approve, apply, verify, save, and undo edits to one open spreadsheet through a stable agent-oriented tool protocol.

**Architecture:** A loopback-only Node Local Host serves a small Web Shell, supervises a pinned Harness child, and routes versioned WebSocket frames by document and browser client identity. The existing GenOffice Sheets renderer implements the first `EditorAdapter`; its workbook DSL remains the engine-facing vocabulary while the new protocol, idempotency store, approval lifecycle, and tool results remain engine-neutral.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, React 19, Vite 7, Vitest 4, Playwright 1.61, `ws` 8, Zod 4, DeepSeek Harness `0.1.6-alpha.2`, GenOffice Sheets/Univer.

**Spec:** `docs/superpowers/specs/2026-09-19-nexusdesk-local-web-agent-platform-design.md`

## Global Constraints

- The first implementation is single-user, local-only, and listens only on `127.0.0.1`.
- It must open and function in current Chromium browsers and the Codex built-in browser without Electron preload APIs.
- Users must not install Node.js, Docker, DeepSeek Harness, or a separate Harness profile for a packaged build.
- DeepSeek Harness is pinned to exactly `0.1.6-alpha.2` for this milestone and stays behind `@nexusdesk/runtime-host`.
- The browser, Web Shell, and editor adapters must not import DeepSeek Harness types.
- The Local Host and Harness must not import Univer or any Sheets renderer type.
- No MCP server, MCP transport, arbitrary shell tool, user skill, or user plugin is added.
- Tool inputs and results must not expose engine-owned objects or unbounded workbook data.
- Every mutation requires `sessionId`, `documentId`, `editorType`, `revision`, `operationId`, and `clientId`.
- Every mutation is proposed, approved once, applied transactionally, verified, and recorded idempotently.
- Existing uncommitted Sheets/Harness prototype changes belong to the user. Integrate them deliberately; do not discard or overwrite them.
- This milestone does not implement Docs, Slides, Keychain storage, packaging, or collaboration. Those receive separate implementation plans after this reference vertical slice passes.

## Review Focus

- A malicious page connects to the loopback WebSocket with a valid-looking path but an unrecognized `Origin`; Task 3 must prove the connection is rejected before any document metadata is returned.
- A browser retries an already committed `operationId` with a different payload; Task 4 must prove the host rejects the collision instead of returning or reapplying the first result.
- The user switches or reloads tabs between proposal and approval; Task 8 must prove a changed `clientId` or `revision` prevents the write.
- The browser disconnects after the adapter commits but before the result reaches the host; Tasks 4 and 8 must prove reconnection returns the recorded result and does not apply twice.
- Harness exits while a write approval is pending; Task 6 must prove the approval expires, the document remains unchanged, and the Web client receives a terminal failure.

---

## Milestone decomposition

The approved product spec spans several independently reviewable systems. This plan intentionally delivers only the foundation plus the Sheets reference vertical slice. After it passes, create three follow-on plans:

1. `nexusdesk-docs-slides-adapters`: implement Docs and Slides against the frozen adapter contract.
2. `nexusdesk-provider-secrets-packaging`: add provider settings, macOS Keychain, bundled Node, launcher, signing, and notarization.
3. `nexusdesk-editor-extension-kit`: document and test third-party product-owned editor registration; collaboration remains a later product spec because it is a first-release non-goal.

## File structure

### New protocol package

- `packages/nexusdesk-protocol/src/identity.ts`: branded string identities and revision helpers.
- `packages/nexusdesk-protocol/src/frames.ts`: discriminated browser/host and host/runtime frames.
- `packages/nexusdesk-protocol/src/editor.ts`: adapter requests, edit plans, verification, and agent-facing results.
- `packages/nexusdesk-protocol/src/schemas.ts`: Zod parsers used only at wire boundaries.
- `packages/nexusdesk-protocol/src/index.ts`: public exports.

### New Local Host application

- `apps/local-host/src/bootstrap-auth.ts`: one-use bootstrap token and cookie exchange.
- `apps/local-host/src/origin-policy.ts`: loopback Host and browser Origin policy.
- `apps/local-host/src/document-registry.ts`: document/client/revision ownership.
- `apps/local-host/src/operation-store.ts`: idempotent mutation reservation and terminal results.
- `apps/local-host/src/ws-session.ts`: authenticated WebSocket parsing and routing.
- `apps/local-host/src/harness-supervisor.ts`: lifecycle for the dedicated runtime child.
- `apps/local-host/src/server.ts`: dependency assembly and HTTP endpoints.
- `apps/local-host/src/main.ts`: executable entry point and startup URL output.

### New runtime adapter package

- `packages/nexusdesk-runtime-host/src/protocol.ts`: runtime-only request/response types re-exported from the stable protocol where possible.
- `packages/nexusdesk-runtime-host/src/index.ts`: Harness boot, session creation, stream projection, approval, and tool routing.
- `packages/nexusdesk-runtime-host/profile/cordis.patch.yml`: bundled official Sheets tool composition.

### New browser client package

- `packages/nexusdesk-web-client/src/client.ts`: authenticated WebSocket client with reconnect and request correlation.
- `packages/nexusdesk-web-client/src/agent-api.ts`: renderer-facing `AgentApi` implementation.
- `packages/nexusdesk-web-client/src/editor-registration.ts`: document/adapter registration.

### Sheets changes

- `apps/sheets/src/renderer/agent/sheets-command.ts`: transport-neutral command validation and execution extracted from `mcp-bridge.ts`.
- `apps/sheets/src/renderer/agent/sheets-adapter.ts`: document/revision/idempotency adapter over existing handlers.
- `apps/sheets/src/renderer/agent/browser-agent-api.ts`: installs the Web client in browser mode.
- `apps/sheets/src/renderer/mcp-bridge.ts`: retains MCP compatibility by delegating command execution to `sheets-command.ts`; MCP is not used by NexusDesk.
- `apps/sheets/src/renderer/ai/loop-runtime.ts`: consumes the stable `AgentApi`, not Electron-global runtime types.
- `apps/sheets/src/renderer/main.tsx`: selects Electron or local-Web bootstrap explicitly.

### New Web Shell

- `apps/web/src/App.tsx`: document tabs and module routing for the first Sheets slice.
- `apps/web/src/bootstrap.ts`: consumes the bootstrap URL and initializes the authenticated client.
- `apps/web/src/main.tsx`: React entry point.
- `apps/web/vite.config.ts`: development proxy and production asset build.

## Task 1: Establish the stable NexusDesk protocol package

**Files:**
- Create: `packages/nexusdesk-protocol/package.json`
- Create: `packages/nexusdesk-protocol/tsconfig.json`
- Create: `packages/nexusdesk-protocol/src/identity.ts`
- Create: `packages/nexusdesk-protocol/src/editor.ts`
- Create: `packages/nexusdesk-protocol/src/frames.ts`
- Create: `packages/nexusdesk-protocol/src/schemas.ts`
- Create: `packages/nexusdesk-protocol/src/index.ts`
- Create: `packages/nexusdesk-protocol/tests/schemas.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: no earlier task.
- Produces: `DocumentId`, `SessionId`, `ClientId`, `OperationId`, `Revision`, `ClientFrame`, `AgentServerFrame`, `EditorAdapter`, `EditorRequestFrame`, `EditorResponseFrame`, `AgentToolResult`, `EditPlan`, `parseClientFrame(value): ClientFrame`.

- [ ] **Step 1: Create the package manifest and failing schema tests**

```json
{
  "name": "@nexusdesk/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "zod": "^4.3.6" },
  "devDependencies": { "typescript": "^5.9.3", "vitest": "^4.1.11" }
}
```

Test exact acceptance cases: protocol version mismatch, missing `operationId`, negative revision, unknown frame type, and an engine object-shaped extra property on an agent result.

- [ ] **Step 2: Run the protocol tests and confirm the missing-module failure**

Run: `npm test -w @nexusdesk/protocol`

Expected: FAIL because `src/index.ts` and parsers do not exist.

- [ ] **Step 3: Implement branded identities and discriminated frame schemas**

Use string brands only at compile time and Zod validation at the wire boundary:

```ts
export type Brand<T, B extends string> = T & { readonly __brand: B }
export type DocumentId = Brand<string, 'DocumentId'>
export type OperationId = Brand<string, 'OperationId'>
export type Revision = Brand<number, 'Revision'>

export const PROTOCOL_VERSION = 1 as const

export interface MutationTarget {
  sessionId: SessionId
  documentId: DocumentId
  editorType: string
  revision: Revision
  operationId: OperationId
  clientId: ClientId
}
```

Define `AgentToolResult` with `additionalProperties: false` semantics in its Zod schema. Do not include `unknown` result payload fields.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w @nexusdesk/protocol && npm run typecheck -w @nexusdesk/protocol`

Expected: PASS.

- [ ] **Step 5: Add the package to root aggregate scripts and refresh the lockfile**

Add `@nexusdesk/protocol` to the root `test` and `typecheck` sequences, then run `npm install --package-lock-only`.

- [ ] **Step 6: Commit the protocol package**

```bash
git add package.json package-lock.json packages/nexusdesk-protocol
git commit -m "feat: define NexusDesk agent and editor protocol"
```

## Task 2: Implement bootstrap authentication and loopback origin policy

**Files:**
- Create: `apps/local-host/package.json`
- Create: `apps/local-host/tsconfig.json`
- Create: `apps/local-host/src/bootstrap-auth.ts`
- Create: `apps/local-host/src/origin-policy.ts`
- Create: `apps/local-host/tests/bootstrap-auth.test.ts`
- Create: `apps/local-host/tests/origin-policy.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION` from `@nexusdesk/protocol`.
- Produces: `createBootstrapAuth(randomBytes): BootstrapAuth`, `acceptHttpOrigin(request): boolean`, `acceptWebSocketOrigin(request): boolean`.

- [ ] **Step 1: Write failing tests for one-use tokens and host/origin rejection**

Cover these exact cases:

```ts
expect(auth.exchange('token').ok).toBe(true)
expect(auth.exchange('token').ok).toBe(false) // replay
expect(acceptWebSocketOrigin(req('evil.example', 'https://evil.example'))).toBe(false)
expect(acceptWebSocketOrigin(req('127.0.0.1:43123', 'http://127.0.0.1:43123'))).toBe(true)
expect(acceptWebSocketOrigin(req('localhost:43123', 'http://127.0.0.1:43123'))).toBe(false)
```

- [ ] **Step 2: Run tests and confirm they fail because the modules are absent**

Run: `npm test -w @nexusdesk/local-host -- bootstrap-auth origin-policy`

Expected: FAIL with module resolution errors.

- [ ] **Step 3: Implement one-use token exchange**

Generate 32 random bytes, encode with base64url, compare with `timingSafeEqual`, expire after 60 seconds, invalidate on first successful exchange, and return a separate 32-byte session ID for an HttpOnly `SameSite=Strict` cookie.

- [ ] **Step 4: Implement strict loopback Host and Origin checks**

Accept only the exact bound host/port supplied to the policy constructor. Reject absent Origins for WebSocket upgrades, `null`, DNS aliases, LAN addresses, and mismatched ports.

- [ ] **Step 5: Run security tests and typecheck**

Run: `npm test -w @nexusdesk/local-host -- bootstrap-auth origin-policy && npm run typecheck -w @nexusdesk/local-host`

Expected: PASS.

- [ ] **Step 6: Commit bootstrap security**

```bash
git add package.json package-lock.json apps/local-host
git commit -m "feat: secure NexusDesk local bootstrap"
```

## Task 3: Serve the Web application and authenticate WebSockets

**Files:**
- Create: `apps/local-host/src/server.ts`
- Create: `apps/local-host/src/ws-session.ts`
- Create: `apps/local-host/src/main.ts`
- Create: `apps/local-host/tests/server.test.ts`
- Create: `apps/local-host/tests/ws-session.test.ts`
- Modify: `apps/local-host/package.json`

**Interfaces:**
- Consumes: Task 2 authentication/origin policy and `parseClientFrame` from Task 1.
- Produces: `startLocalHost(options): Promise<RunningLocalHost>` where `RunningLocalHost` exposes `origin`, `bootstrapUrl`, and `close()`.

- [ ] **Step 1: Write failing HTTP and WebSocket integration tests**

Tests must assert:

- `/bootstrap?token=<bootstrap-token>` returns `303`, sets an HttpOnly cookie, and redirects to `/` without the token;
- replaying the bootstrap URL returns `401`;
- `/health` returns no document or session data;
- an authenticated same-origin WebSocket receives `server:ready`;
- the malicious-Origin case from Review Focus closes before `server:ready`.

- [ ] **Step 2: Run the focused tests**

Run: `npm test -w @nexusdesk/local-host -- server ws-session`

Expected: FAIL because `startLocalHost` does not exist.

- [ ] **Step 3: Implement the Node HTTP server without a framework**

Use `node:http` and `ws`'s `WebSocketServer({ noServer: true })`. Bind with:

```ts
server.listen({ host: '127.0.0.1', port: 0 })
```

Never fall back to `0.0.0.0`. Enforce a 1 MiB WebSocket frame limit and close invalid JSON or invalid protocol frames with code `1008`.

- [ ] **Step 4: Implement startup and shutdown**

`main.ts` prints exactly one machine-readable line containing the bootstrap URL, handles `SIGINT`/`SIGTERM`, stops accepting sockets, closes clients, and then closes the HTTP server.

- [ ] **Step 5: Run the server suite**

Run: `npm test -w @nexusdesk/local-host && npm run typecheck -w @nexusdesk/local-host`

Expected: PASS, including the malicious Origin test.

- [ ] **Step 6: Commit the authenticated Local Host**

```bash
git add apps/local-host
git commit -m "feat: serve authenticated NexusDesk local web sessions"
```

## Task 4: Add document ownership, revisions, and idempotent operations

**Files:**
- Create: `apps/local-host/src/document-registry.ts`
- Create: `apps/local-host/src/operation-store.ts`
- Create: `apps/local-host/tests/document-registry.test.ts`
- Create: `apps/local-host/tests/operation-store.test.ts`
- Modify: `apps/local-host/src/ws-session.ts`

**Interfaces:**
- Consumes: Task 1 identities and editor frames.
- Produces: `DocumentRegistry.register`, `.assertOwner`, `.commitRevision`, `.detachClient`; `OperationStore.reserve`, `.commit`, `.fail`, `.lookup`.

- [ ] **Step 1: Write failing ownership and idempotency tests**

Pin these behaviors:

```ts
registry.assertOwner({ documentId, clientId: otherClient, revision }) // throws WRONG_CLIENT
registry.assertOwner({ documentId, clientId, revision: oldRevision }) // throws STALE_REVISION
store.reserve(operationId, hashA)
store.reserve(operationId, hashA) // returns existing pending/terminal state
store.reserve(operationId, hashB) // throws OPERATION_ID_COLLISION
```

Also simulate commit followed by disconnect and retry; `lookup(operationId)` must return the committed `AgentToolResult`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -w @nexusdesk/local-host -- document-registry operation-store`

Expected: FAIL because registries are absent.

- [ ] **Step 3: Implement in-memory registries with explicit state transitions**

Use `sha256` over canonical JSON to bind an operation ID to one payload. Valid operation states are `reserved`, `committed`, and `failed`; no transition may leave a terminal state.

- [ ] **Step 4: Connect browser registration and detach frames**

`ws-session.ts` accepts `editor:register`, `editor:revision`, and `editor:detach`. Socket close detaches every document owned by that client and prevents new writes until explicit re-registration.

- [ ] **Step 5: Run registry, socket, and type tests**

Run: `npm test -w @nexusdesk/local-host && npm run typecheck -w @nexusdesk/local-host`

Expected: PASS, including both idempotency Review Focus cases.

- [ ] **Step 6: Commit document authority**

```bash
git add apps/local-host/src apps/local-host/tests
git commit -m "feat: track NexusDesk document revisions and operations"
```

## Task 5: Move the Harness adapter into the product repository

**Files:**
- Create: `packages/nexusdesk-runtime-host/package.json`
- Create: `packages/nexusdesk-runtime-host/tsconfig.json`
- Create: `packages/nexusdesk-runtime-host/src/protocol.ts`
- Create: `packages/nexusdesk-runtime-host/src/index.ts`
- Create: `packages/nexusdesk-runtime-host/profile/cordis.patch.yml`
- Create: `packages/nexusdesk-runtime-host/tests/projection.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Reference source: `../packages/runtime-host/src/index.ts`
- Reference source: `../packages/runtime-host/src/protocol.ts`
- Reference source: `../packages/office-tools/cordis.patch.yml`

**Interfaces:**
- Consumes: Task 1 runtime frames; exact Harness `0.1.6-alpha.2` APIs.
- Produces: an executable `lib/index.mjs` that speaks only the NexusDesk runtime protocol over Node IPC.

- [ ] **Step 1: Write projection tests before copying the runtime**

Extract pure functions and test that reasoning deltas and raw Harness objects are not forwarded, text deltas are forwarded, and durable tool events become stable `agent:event` frames.

- [ ] **Step 2: Run tests and confirm missing exports**

Run: `npm test -w @nexusdesk/runtime-host`

Expected: FAIL because the package has not been implemented.

- [ ] **Step 3: Port the existing runtime host behind the stable protocol**

Preserve the known-good Harness boot/session logic, but replace imports from the sibling `../packages` tree with `@nexusdesk/protocol`. Keep these explicit filters:

```ts
const STREAM_FORWARD = new Set(['block-start', 'block-end', 'text-delta', 'tool-call-delta'])
```

Do not expose `ctx`, agent handles, session objects, or raw Harness event payloads to browser code.

- [ ] **Step 4: Pin dependencies and build the executable**

Set every `@deepseek-ai/dsh-*` dependency to `0.1.6-alpha.2` without caret or tilde. Add an esbuild build script that emits `lib/index.mjs` but leaves pinned Harness packages external in the runtime tree.

- [ ] **Step 5: Run package tests, build, and a child-process ready smoke**

Run: `npm test -w @nexusdesk/runtime-host && npm run typecheck -w @nexusdesk/runtime-host && npm run build -w @nexusdesk/runtime-host`

Expected: PASS; the smoke fixture receives `ready` and then `shutdown-complete`.

- [ ] **Step 6: Commit the product-owned runtime adapter**

```bash
git add package.json package-lock.json packages/nexusdesk-runtime-host
git commit -m "feat: isolate Harness behind NexusDesk runtime protocol"
```

## Task 6: Supervise Harness and terminate pending approvals safely

**Files:**
- Create: `apps/local-host/src/harness-supervisor.ts`
- Create: `apps/local-host/src/agent-router.ts`
- Create: `apps/local-host/tests/fixtures/fake-runtime.mjs`
- Create: `apps/local-host/tests/harness-supervisor.test.ts`
- Create: `apps/local-host/tests/agent-router.test.ts`
- Modify: `apps/local-host/src/server.ts`
- Modify: `apps/local-host/src/ws-session.ts`

**Interfaces:**
- Consumes: Task 5 child protocol, Task 4 registries.
- Produces: `HarnessSupervisor.startTurn`, `.cancelTurn`, `.respondApproval`, `.shutdown`; `AgentRouter.routeRuntimeFrame`.

- [ ] **Step 1: Write failing lifecycle tests using a deterministic fake child**

The fixture emits `ready`, `approval:request`, text deltas, tool calls, fatal exit, and shutdown completion on commands. Tests cover normal completion, cancellation, crash, restart while idle, and no automatic turn replay.

- [ ] **Step 2: Add the pending-approval crash test from Review Focus**

After an `approval:request`, terminate the fake child. Assert that the router sends one fatal terminal frame, invalidates the approval ID, and records no operation reservation or document revision.

- [ ] **Step 3: Run supervisor tests and confirm failure**

Run: `npm test -w @nexusdesk/local-host -- harness-supervisor agent-router`

Expected: FAIL because the supervisor is absent.

- [ ] **Step 4: Implement child lifecycle and frame routing**

Spawn a dedicated Node executable with IPC. Restart after an unexpected idle crash, but never replay a turn. On shutdown, request graceful exit, then `SIGTERM`, then `SIGKILL` using bounded timers.

- [ ] **Step 5: Route authenticated browser agent requests**

Accept `agent:start`, `agent:cancel`, and `approval:response` only from the session that owns them. Bind approvals to their exact tool call and expire them on runtime exit, browser disconnect, document revision change, or 120-second timeout.

- [ ] **Step 6: Run the complete Local Host suite**

Run: `npm test -w @nexusdesk/local-host && npm run typecheck -w @nexusdesk/local-host`

Expected: PASS.

- [ ] **Step 7: Commit Harness supervision**

```bash
git add apps/local-host
git commit -m "feat: supervise Harness sessions in the local host"
```

## Task 7: Implement the browser client and stable Agent API

**Files:**
- Create: `packages/nexusdesk-web-client/package.json`
- Create: `packages/nexusdesk-web-client/tsconfig.json`
- Create: `packages/nexusdesk-web-client/src/client.ts`
- Create: `packages/nexusdesk-web-client/src/agent-api.ts`
- Create: `packages/nexusdesk-web-client/src/editor-registration.ts`
- Create: `packages/nexusdesk-web-client/src/index.ts`
- Create: `packages/nexusdesk-web-client/tests/client.test.ts`
- Create: `packages/nexusdesk-web-client/tests/agent-api.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 1 frames.
- Produces: `createNexusClient(options): NexusClient`, `createAgentApi(client): AgentApi`, `registerEditor(client, registration): EditorRegistrationHandle`.

- [ ] **Step 1: Write failing reconnect and correlation tests with a fake WebSocket**

Assert one listener per connection, request correlation by frame ID, exponential reconnect capped at five seconds, no mutation resend after disconnect, and explicit `editor:register` after reconnection.

- [ ] **Step 2: Run tests and confirm the package is missing**

Run: `npm test -w @nexusdesk/web-client`

Expected: FAIL.

- [ ] **Step 3: Implement the client state machine**

Use states `idle`, `connecting`, `ready`, `reconnecting`, and `closed`. Queue only safe registration and read frames while reconnecting. Reject queued mutation and approval frames with `CONNECTION_LOST`.

- [ ] **Step 4: Implement `AgentApi` without Electron globals**

Expose:

```ts
interface AgentApi {
  startTurn(input: { prompt: string; documentId: string; sessionId: string }): void
  cancelTurn(sessionId: string): void
  respondApproval(id: string, outcome: ApprovalOutcome): void
  onFrame(callback: (frame: AgentServerFrame) => void): () => void
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w @nexusdesk/web-client && npm run typecheck -w @nexusdesk/web-client`

Expected: PASS.

- [ ] **Step 6: Commit the Web client**

```bash
git add package.json package-lock.json packages/nexusdesk-web-client
git commit -m "feat: add NexusDesk browser transport"
```

## Task 8: Extract a transaction-safe Sheets adapter

**Files:**
- Create: `apps/sheets/src/renderer/agent/sheets-command.ts`
- Create: `apps/sheets/src/renderer/agent/sheets-adapter.ts`
- Create: `apps/sheets/tests/sheets-command.test.ts`
- Create: `apps/sheets/tests/sheets-adapter.test.ts`
- Modify: `apps/sheets/src/renderer/mcp-bridge.ts`
- Modify: `apps/sheets/src/renderer/App.tsx`
- Modify: `apps/sheets/package.json`

**Interfaces:**
- Consumes: Task 1 editor contract and the existing `McpSheetHandlers` behavior.
- Produces: `executeSheetsCommand(handlers, command): Promise<AgentToolResult>` and `createSheetsAdapter(options): EditorAdapter`.

- [ ] **Step 1: Characterize the existing bridge before refactoring**

Extend the existing bridge tests to pin read-by-name, invalid operation diagnostics, dry-run behavior, in-place save, and apply order. Run them before moving code.

Run: `npm test -w @genoffice/sheets -- mcp-bridge-ops mcp-sheet-refs`

Expected: PASS on the existing implementation.

- [ ] **Step 2: Write failing adapter tests**

Cover proposal without mutation, approval bound to plan hash, stale revision, wrong client, one transaction per operation batch, rollback on verification failure, and agent-oriented result fields only.

- [ ] **Step 3: Extract transport-neutral command execution**

Move command parsing, sheet-name resolution, Zod workbook operation validation, and error mapping from `mcp-bridge.ts` into `sheets-command.ts`. Keep `installSheetsMcpBridge` as a compatibility wrapper that supplies its existing reply callback.

- [ ] **Step 4: Implement proposal, apply, verification, and undo**

Use the existing `planOperations`/`applyChangePlan` and edit journal. The adapter returns summaries such as affected sheets/ranges and formula error counts, never Univer objects or raw workbook snapshots.

- [ ] **Step 5: Pin wrong-tab and disconnect-after-commit behavior**

The adapter validates `clientId` and revision immediately before applying. Record the terminal result before attempting WebSocket delivery. The reconnect test asks for the same `operationId` and receives that result with no second `applyOps` call.

- [ ] **Step 6: Run Sheets focused tests and typecheck**

Run: `npm test -w @genoffice/sheets -- sheets-command sheets-adapter mcp-bridge-ops mcp-sheet-refs && npm run typecheck -w @genoffice/sheets`

Expected: PASS.

- [ ] **Step 7: Commit the reference adapter**

```bash
git add apps/sheets/src/renderer/agent apps/sheets/src/renderer/mcp-bridge.ts apps/sheets/src/renderer/App.tsx apps/sheets/tests apps/sheets/package.json
git commit -m "feat: expose Sheets through the NexusDesk editor adapter"
```

## Task 9: Make Sheets boot in an authenticated browser session

**Files:**
- Create: `apps/sheets/src/renderer/agent/browser-agent-api.ts`
- Create: `apps/sheets/src/renderer/browser-host-api.ts`
- Create: `apps/sheets/tests/browser-host-api.test.ts`
- Modify: `apps/sheets/src/renderer/main.tsx`
- Modify: `apps/sheets/src/renderer/ai/loop-runtime.ts`
- Modify: `apps/sheets/src/renderer/env.d.ts`
- Modify: `apps/sheets/vite.renderer.config.ts`

**Interfaces:**
- Consumes: Task 7 Web client, Task 8 Sheets adapter.
- Produces: `installBrowserHostApi(bootstrap): BrowserHostHandle`; browser-mode `window.agentApi` with the same stable `AgentApi` consumed by `loop-runtime.ts`.

- [ ] **Step 1: Write failing browser-host selection tests**

Test explicit modes only: `?host=local-web` installs the browser implementation; Electron preload presence selects Electron; absence of both renders a visible startup error rather than silently constructing a partial API.

- [ ] **Step 2: Run the focused test**

Run: `npm test -w @genoffice/sheets -- browser-host-api`

Expected: FAIL because the selector is absent.

- [ ] **Step 3: Implement the minimum browser host needed by the Sheets slice**

Map language, theme, open-document metadata, save, agent frames, and editor registration to Local Host endpoints. Unsupported desktop-only actions return a typed `UNAVAILABLE_IN_WEB` result and disable their UI command; do not install a permissive proxy or fabricate success.

- [ ] **Step 4: Replace sibling runtime type imports**

Update the current prototype files to import `AgentApi`, approval types, and server frames from `@nexusdesk/protocol`/`@nexusdesk/web-client`. Preserve Electron compatibility without importing from `../../../../../packages/runtime-host` outside the repository.

- [ ] **Step 5: Add Vite development proxy rules**

Proxy `/api` and `/ws` to the Local Host URL supplied by `NEXUSDESK_LOCAL_ORIGIN`; fail startup if browser mode is requested without it.

- [ ] **Step 6: Run Sheets unit tests, typecheck, and renderer build**

Run: `npm test -w @genoffice/sheets -- browser-host-api sheets-adapter && npm run typecheck -w @genoffice/sheets && npm run dev:renderer -w @genoffice/sheets -- --host 127.0.0.1`

Expected: tests/typecheck pass; the dev server starts and `/` renders without Electron.

- [ ] **Step 7: Commit browser boot support**

```bash
git add apps/sheets
git commit -m "feat: run GenOffice Sheets in NexusDesk local web"
```

## Task 10: Build the first Web Shell and static production assembly

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/bootstrap.ts`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/tests/bootstrap.test.ts`
- Modify: `apps/local-host/src/server.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 3 bootstrap session and Task 9 browser-ready Sheets module.
- Produces: `/` Web Shell and `/edit/sheets/:documentId` route.

- [ ] **Step 1: Write failing bootstrap UI tests**

Assert that missing authentication shows a reconnect action, a valid bootstrap lists the registered document, and navigation uses the stable `documentId`, never a filesystem path in the URL.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test -w @nexusdesk/web`

Expected: FAIL because the Web app does not exist.

- [ ] **Step 3: Implement the minimal Web Shell**

Render connection status, one document tab strip, the Sheets module route, and a visible terminal error boundary. Do not add inactive Docs, Slides, collaboration, account, or plugin screens.

- [ ] **Step 4: Serve hashed assets from Local Host**

Build Web Shell and Sheets browser assets, mount them read-only, send `Cache-Control: no-store` for `index.html`, and immutable caching for content-hashed assets. Unknown `/api` routes return JSON `404`; client routes fall back to the Web Shell HTML.

- [ ] **Step 5: Add root development and production scripts**

Add:

```json
{
  "dev:web": "concurrently -k -n host,web,sheets \"npm run dev -w @nexusdesk/local-host\" \"npm run dev -w @nexusdesk/web\" \"npm run dev:renderer -w @genoffice/sheets\"",
  "build:web": "npm run build:web-renderer -w @genoffice/sheets && npm run build -w @nexusdesk/web && npm run build -w @nexusdesk/local-host",
  "start:web": "node apps/local-host/lib/main.mjs"
}
```

Add `"build:web-renderer": "vite build --config vite.renderer.config.ts --outDir out/web"` to `@genoffice/sheets`; add `dev` and `build` scripts to both new applications using Vite for Web and esbuild for Local Host.

- [ ] **Step 6: Run Web Shell and Local Host tests/builds**

Run: `npm test -w @nexusdesk/web && npm run build:web`

Expected: PASS; `npm run start:web` prints one bootstrap URL and serves the built application.

- [ ] **Step 7: Commit the Web Shell**

```bash
git add apps/web apps/local-host/src/server.ts package.json package-lock.json
git commit -m "feat: add NexusDesk local web shell"
```

## Task 11: Prove the complete keyless Sheets agent flow

**Files:**
- Create: `e2e/local-web-sheets-agent.spec.ts`
- Create: `e2e/helpers/local-web.ts`
- Create: `e2e/fixtures/fake-harness-runtime.mjs`
- Create: `e2e/fixtures/sheets-agent-input.xlsx`
- Modify: `e2e/playwright.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: a repeatable, keyless product acceptance test.

- [ ] **Step 1: Write the failing end-to-end test**

The test launches Local Host with the fake Harness fixture, opens the emitted bootstrap URL in Chromium, registers a workbook, starts an agent turn, approves a formula-and-chart plan, observes streaming text, saves, reloads the browser, retries the same operation ID, and downloads/reopens the final workbook through the independent CLI reader.

- [ ] **Step 2: Run the test and capture the first failing boundary**

Run: `npx playwright test e2e/local-web-sheets-agent.spec.ts --project=chromium`

Expected: FAIL until the fixture hooks and final route wiring are present.

- [ ] **Step 3: Add deterministic runtime injection for tests**

Allow `startLocalHost` tests to receive an explicit `runtimeCommand` and arguments. Production startup always resolves the bundled runtime path and ignores environment overrides.

- [ ] **Step 4: Make the acceptance flow pass without model credentials**

The fake runtime must issue the same versioned frames as the real runtime, including approval and tool requests. Assertions inspect the saved workbook, not assistant prose.

- [ ] **Step 5: Run focused and regression checks**

Run:

```bash
npm test -w @nexusdesk/protocol
npm test -w @nexusdesk/local-host
npm test -w @nexusdesk/web-client
npm test -w @genoffice/sheets -- sheets-command sheets-adapter browser-host-api mcp-bridge-ops
npx playwright test e2e/local-web-sheets-agent.spec.ts --project=chromium
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the vertical-slice acceptance test**

```bash
git add e2e package.json
git commit -m "test: verify local web Sheets agent flow"
```

## Task 12: Document operation and freeze the next-plan interfaces

**Files:**
- Create: `docs/nexusdesk/local-web-development.md`
- Create: `docs/nexusdesk/editor-adapter.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-19-nexusdesk-local-web-agent-platform-design.md` only if implementation discovered a factual contract correction.

**Interfaces:**
- Consumes: the final public contracts from Tasks 1, 7, and 8.
- Produces: developer instructions and the frozen adapter contract required by the Docs/Slides follow-on plan.

- [ ] **Step 1: Write exact local development and debugging commands**

Document startup output, how to open the bootstrap URL in the Codex built-in browser, how to attach Node Inspector to Local Host/Harness, how to inspect WebSocket frames, and how to run the keyless acceptance test.

- [ ] **Step 2: Document the editor adapter invariants**

Include identity fields, lifecycle frames, proposal/apply/verify sequence, idempotency, disconnect behavior, result envelope, payload limits, and a complete minimal adapter example using the real exported names.

- [ ] **Step 3: Run documentation and final diff checks**

Run:

```bash
npm run format:check
npm run lint
git diff --check
```

Expected: PASS with no unfinished markers or cross-repository runtime imports.

- [ ] **Step 4: Commit milestone documentation**

```bash
git add README.md docs/nexusdesk docs/superpowers/specs/2026-09-19-nexusdesk-local-web-agent-platform-design.md
git commit -m "docs: explain NexusDesk local web architecture"
```

- [ ] **Step 5: Run milestone verification once**

Run the focused command set from Task 11, then record the exact commands and results in the implementation handoff. Do not claim Docs, Slides, Keychain, packaging, Safari, or collaboration support.

## Definition of done

This plan is complete only when a clean checkout can install dependencies, build the Local Host/Web Shell/Sheets assets, start on a loopback random port, authenticate a Chromium client, execute the keyless Harness-to-Sheets edit flow exactly once, survive browser reconnection without a duplicate write, save a structurally valid workbook, and pass the focused unit, type, and end-to-end commands above.
