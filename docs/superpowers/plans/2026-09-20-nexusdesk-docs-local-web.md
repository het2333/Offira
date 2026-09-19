# NexusDesk Docs Local Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open, edit, Agent-edit, save, reload, and recover authorized `.docx` files in the shared NexusDesk Web Shell while preserving the GenOffice Docs renderer and exposing its stable operation DSL as native Harness tools.

**Architecture:** Generalize the Local Host from one Sheets service to a registry of document-scoped drivers, then add authenticated binary content and revision-checked writes. Install a preload-shaped Docs browser adapter before React mounts, extract the existing Docs command execution from MCP transport, and connect a Docs editor adapter to the existing NexusDesk WebSocket/approval journal and Harness runtime.

**Tech Stack:** TypeScript 5.9, React 19, Vite 7, Node HTTP/WebSocket and filesystem APIs, Zod, Vitest, Playwright Chromium, `@genoffice/docx-engine`, `@nexusdesk/protocol`, DeepSeek Harness runtime host.

**Spec:** `docs/superpowers/specs/2026-09-20-nexusdesk-multi-editor-local-host-design.md`

## Global Constraints

- The Local Host is authoritative for authorized paths, document identity, revision, recovery, tabs, settings, and Agent routing.
- GenOffice Docs remains the visual editor and DOCX engine; NexusDesk adds adapters and does not fork its renderer.
- Browser-safe renderer and protocol code may not import Electron, Node filesystem APIs, or raw Harness internals.
- Large DOCX bytes use authenticated `application/octet-stream` endpoints, not JSON or base64.
- Writes are capped at 128 MiB, validated as parseable DOCX, written to a private sibling temporary file, fsynced, and atomically renamed.
- Every write supplies an expected revision; stale writes fail with typed `REVISION_CONFLICT` and never replace the file.
- Unsupported native-only Docs functions reject with `UNAVAILABLE_IN_WEB` and their controls are hidden through runtime capability checks.
- NexusDesk uses native Harness tools only; the existing GenOffice MCP bridge remains a compatibility transport over the same executor.
- Tool results are bounded `AgentToolResult` envelopes and never contain ProseMirror, DOCX engine, Electron, or Harness objects.
- Mutations follow propose -> exact one-time approval -> apply -> verify, and `operationId` replay is idempotent across reconnect/reload.
- Existing Sheets behavior and its test suites remain green throughout this milestone.

## Review Focus

- A stale browser tab must receive `REVISION_CONFLICT` without changing disk bytes; Task 2 adds a byte-for-byte integration test.
- A malformed or oversized DOCX upload must not replace the authorized file or leave a committed revision; Tasks 2 and 3 add validation and cleanup tests.
- A renderer-supplied path must never redirect a load or save outside the authorized document; Tasks 2 and 4 test that only the document id controls the target.
- Reload/reconnect after an approved edit must replay the saved Agent result without applying the edit twice; Tasks 6 and 8 add journal and Chromium tests.
- Electron Docs must continue to use its existing preload while Web mode installs the browser adapter before React; Tasks 4 and 5 add host-selection and build tests.

---

### Task 1: Replace the singleton document service with a driver registry

**Files:**

- Create: `apps/local-host/src/document-driver.ts`
- Create: `apps/local-host/tests/document-driver.test.ts`
- Modify: `apps/local-host/src/server.ts`
- Modify: `apps/local-host/src/sheets-document-service.ts`
- Modify: `apps/local-host/src/main.ts`
- Modify: `apps/local-host/tests/server.test.ts`
- Modify: `apps/local-host/tests/sheets-document-service.test.ts`

**Interfaces:**

- Consumes: `EditorKind`, `ShellDocumentSummary`, and the existing Sheets document service.
- Produces: `LocalDocument`, `LocalDocumentDriver`, `DocumentDriverRegistry`, `StartLocalHostOptions.documentDrivers`, and static editor roots keyed by `EditorKind`.

- [ ] **Step 1: Write the failing registry tests**

```ts
it('routes bootstrap and actions to the driver owning the requested document', async () => {
  const docs = fakeDriver('doc-1', 'docs')
  const sheets = fakeDriver('sheet-1', 'sheets')
  const registry = new DocumentDriverRegistry([docs, sheets])
  expect(await registry.bootstrap('doc-1', 'http://127.0.0.1:1')).toMatchObject({ kind: 'docs' })
  await registry.execute('sheet-1', 'read', { range: 'A1' })
  expect(sheets.actions).toEqual([['read', { range: 'A1' }]])
})

it('fails closed for unknown document ids and duplicate drivers', () => {
  expect(() => new DocumentDriverRegistry([fakeDriver('d1'), fakeDriver('d1')])).toThrow(/duplicate/i)
  expect(() => new DocumentDriverRegistry([]).require('missing')).toThrowError(
    expect.objectContaining({ code: 'DOCUMENT_NOT_FOUND' }),
  )
})
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -w @nexusdesk/local-host -- document-driver server sheets-document-service`

Expected: FAIL because `DocumentDriverRegistry` and `documentDrivers` do not exist.

- [ ] **Step 3: Implement the driver boundary**

```ts
export interface LocalDocument {
  documentId: string
  title: string
  editorType: EditorKind
  revision: number
  path?: string
}

export interface LocalDocumentDriver {
  readonly document: LocalDocument
  bootstrap(origin: string): Promise<unknown>
  execute(action: string, payload: unknown): Promise<unknown>
  readContent?(): Promise<{ bytes: Uint8Array; contentType: string }>
  writeContent?(bytes: Uint8Array, expectedRevision: number): Promise<ShellDocumentSummary>
  close(): Promise<void>
}

export class DocumentDriverRegistry {
  constructor(drivers: readonly LocalDocumentDriver[])
  list(): readonly LocalDocument[]
  require(documentId: string): LocalDocumentDriver
  bootstrap(documentId: string, origin: string): Promise<unknown>
  execute(documentId: string, action: string, payload: unknown): Promise<unknown>
  close(): Promise<void>
}
```

Convert `createSheetsDocumentService` to return `drivers: LocalDocumentDriver[]`; preserve its current action semantics. In `startLocalHost`, derive authorized documents and Shell summaries from the registry, and route every `/api/documents/:id/:action` request through `require(documentId)`.

- [ ] **Step 4: Generalize static editor routing**

```ts
staticAssets?: {
  webRoot: string
  editorRoots: Partial<Record<EditorKind, string>>
}
```

Resolve only `/docs/`, `/sheets/`, `/slides/`, `/pdf/`, `/markdown/`, and `/html/` through their registered roots. Missing editor roots return 404 and never fall through to the Shell SPA.

- [ ] **Step 5: Run the Local Host suite and typecheck**

Run: `npm test -w @nexusdesk/local-host && npm run typecheck -w @nexusdesk/local-host`

Expected: PASS, including existing Sheets routing and shutdown tests.

- [ ] **Step 6: Commit**

```bash
git add apps/local-host
git commit -m "refactor: add Local Host document drivers"
```

### Task 2: Add authenticated binary content and revision writes

**Files:**

- Create: `apps/local-host/src/document-content.ts`
- Create: `apps/local-host/tests/document-content.test.ts`
- Modify: `apps/local-host/src/server.ts`
- Modify: `apps/local-host/tests/server.test.ts`
- Modify: `packages/nexusdesk-office-host/src/schemas.ts`
- Modify: `packages/nexusdesk-office-host/src/index.ts`
- Modify: `packages/nexusdesk-office-host/tests/schemas.test.ts`

**Interfaces:**

- Consumes: `LocalDocumentDriver.readContent/writeContent` from Task 1 and `HostError` from `@nexusdesk/office-host`.
- Produces: `GET /api/documents/:id/content`, `PUT /api/documents/:id/content`, `DocumentWriteResult`, `REVISION_CONFLICT`, `CONTENT_TOO_LARGE`, and `INVALID_DOCUMENT_CONTENT`.

- [ ] **Step 1: Write failing HTTP behavior tests**

```ts
it('streams authorized bytes and atomically advances the expected revision', async () => {
  const loaded = await authenticatedFetch('/api/documents/doc-1/content')
  expect(loaded.headers.get('content-type')).toBe(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
  expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(originalBytes)

  const saved = await authenticatedFetch('/api/documents/doc-1/content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'If-Match': '1' },
    body: nextBytes,
  })
  expect(await saved.json()).toMatchObject({ documentId: 'doc-1', revision: 2 })
})

it('rejects stale and oversized writes without calling the driver', async () => {
  await expectJson(writeContent({ revision: 0, body: nextBytes })).resolves.toMatchObject({
    status: 409,
    body: { code: 'REVISION_CONFLICT', retryable: false },
  })
  await expectJson(writeContent({ revision: 1, body: oversizedBody() })).resolves.toMatchObject({
    status: 413,
    body: { code: 'CONTENT_TOO_LARGE', retryable: false },
  })
  expect(driver.writeCalls).toHaveLength(0)
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @nexusdesk/local-host -- document-content server && npm test -w @nexusdesk/office-host`

Expected: FAIL because the binary routes and error codes are absent.

- [ ] **Step 3: Implement bounded binary reads and writes**

`readBinaryBody(request, 134_217_728)` must reject before allocating beyond the cap, destroy no authorized file, and return `Uint8Array`. Require `PUT`, `Content-Type: application/octet-stream`, and a decimal `If-Match` header. Map `REVISION_CONFLICT` to 409, `CONTENT_TOO_LARGE` to 413, unsupported driver content methods to 405, and successful writes to validated JSON.

```ts
export interface DocumentWriteResult {
  documentId: string
  title: string
  editorType: EditorKind
  revision: number
}
```

- [ ] **Step 4: Run contract and server suites**

Run: `npm test -w @nexusdesk/office-host && npm test -w @nexusdesk/local-host && npm run typecheck -w @nexusdesk/local-host`

Expected: PASS with byte-for-byte unchanged content after stale/oversized requests.

- [ ] **Step 5: Commit**

```bash
git add apps/local-host packages/nexusdesk-office-host
git commit -m "feat: add revision checked document content routes"
```

### Task 3: Implement the DOCX Local Host driver

**Files:**

- Create: `apps/local-host/src/docs-document-driver.ts`
- Create: `apps/local-host/tests/docs-document-driver.test.ts`
- Modify: `apps/local-host/src/startup.ts`
- Modify: `apps/local-host/src/main.ts`
- Modify: `apps/local-host/tests/startup.test.ts`
- Modify: `apps/local-host/package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: `LocalDocumentDriver` from Task 1, binary routes from Task 2, `parseDocx` from `@genoffice/docx-engine`, and an authorized startup `.docx` path.
- Produces: `createDocsDocumentDriver(path): Promise<LocalDocumentDriver>`, deterministic `docx-<sha256(path)[0..16]>` ids, metadata bootstrap, validated atomic writes, and recovery cleanup.

- [ ] **Step 1: Write failing driver tests with real DOCX fixtures**

```ts
it('loads a real docx and exposes metadata without embedding its bytes in bootstrap', async () => {
  const driver = await createDocsDocumentDriver(fixturePath)
  const bootstrap = await driver.bootstrap('http://127.0.0.1:1')
  expect(bootstrap).toEqual({
    documentId: driver.document.documentId,
    title: basename(fixturePath),
    revision: 1,
    websocketUrl: 'ws://127.0.0.1:1/ws',
    language: 'en',
    theme: 'system',
    contentUrl: `/api/documents/${driver.document.documentId}/content`,
  })
})

it('does not replace the docx when parsing the candidate bytes fails', async () => {
  const before = await readFile(fixturePath)
  await expect(driver.writeContent!(new TextEncoder().encode('not a zip'), 1)).rejects.toMatchObject({
    code: 'INVALID_DOCUMENT_CONTENT',
  })
  expect(await readFile(fixturePath)).toEqual(before)
  expect(driver.document.revision).toBe(1)
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @nexusdesk/local-host -- docs-document-driver startup`

Expected: FAIL because the DOCX driver and startup classification are absent.

- [ ] **Step 3: Implement validation and atomic replacement**

Before commit, call `parseDocx(bytes)` and reject password-encrypted/invalid data. Create a same-directory mode-`0600` temporary file, write all bytes, fsync the file, rename it over the authorized path, fsync the parent directory where supported, then update SHA-256, byte size, mtime, and revision. Delete the temporary file on every failure. Serialize concurrent writes so only one matching revision commits.

- [ ] **Step 4: Register `.docx` startup files**

Classify `.docx` as `docs`, `.xlsx` as `sheets`, reject unknown extensions with a clear startup error, and allow both driver kinds to populate one `DocumentDriverRegistry`.

- [ ] **Step 5: Run focused and full Local Host suites**

Run: `npm test -w @nexusdesk/local-host && npm run typecheck -w @nexusdesk/local-host && npm run build -w @nexusdesk/local-host`

Expected: PASS, including invalid DOCX, stale revision, concurrent write, temp cleanup, and existing XLSX startup cases.

- [ ] **Step 6: Commit**

```bash
git add apps/local-host package-lock.json
git commit -m "feat: add Local Host Docs driver"
```

### Task 4: Install a truthful Docs browser DesktopApi

**Files:**

- Create: `apps/docs/src/renderer/browser-host-api.ts`
- Create: `apps/docs/tests/browser-host-api.test.ts`
- Modify: `apps/docs/src/renderer/env.d.ts`
- Modify: `apps/docs/src/renderer/main.tsx`
- Modify: `apps/docs/src/renderer/App.tsx`

**Interfaces:**

- Consumes: metadata and bytes from Tasks 2-3 and the existing `DesktopApi`/`OpenFileResult` contracts.
- Produces: `loadDocsBrowserBootstrap`, `createDocsBrowserDesktopApi`, `installDocsBrowserHostApi`, `selectDocsHost`, and a browser host handle carrying current revision.

- [ ] **Step 1: Write failing adapter tests**

```ts
it('consumes the Host-authorized docx once and ignores caller paths', async () => {
  const api = createDocsBrowserDesktopApi(bootstrap, transport)
  const opened = await api.consumePendingOpenDocx()
  expect(opened).toMatchObject({ path: 'nexusdesk://doc-1', name: 'Report.docx', hash })
  expect(opened && 'data' in opened ? new Uint8Array(opened.data) : null).toEqual(docxBytes)
  await expect(api.consumePendingOpenDocx()).resolves.toBeNull()
  await expect(api.openDocxPath('/tmp/other.docx')).rejects.toMatchObject({ code: 'UNAVAILABLE_IN_WEB' })
})

it('saves bytes with the current revision and advances only after Host success', async () => {
  const result = await api.saveDocx('nexusdesk://doc-1', nextBytes.buffer)
  expect(result).toEqual({ ok: true })
  expect(transport.writes).toEqual([{ expectedRevision: 1, bytes: nextBytes }])
  expect(handle.document.revision).toBe(2)
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @genoffice/docs -- browser-host-api`

Expected: FAIL because the browser adapter does not exist.

- [ ] **Step 3: Implement the browser transport and preload-shaped API**

Load bootstrap JSON and DOCX bytes with `credentials: 'same-origin'`. Use a virtual path `nexusdesk://<documentId>` only as renderer identity; never send it as authority. `saveDocx`, `saveDocxNew`, `writeRecoveryCopy`, settings, theme, and language must have explicit behavior. File dialogs, Save As, encryption/password operations, printing, headless export, external attachment paths, Zotero, OS clipboard helpers, Electron AI transport, and app lifecycle calls reject `DocsWebUnavailableError` unless the existing interface requires a synchronous no-op event unsubscriber.

- [ ] **Step 4: Select the host before importing/rendering App**

```ts
const selection = await selectDocsHost({
  search: window.location.search,
  electronApi: window.desktop,
  installBrowser: () => installDocsBrowserHostApi(documentId),
})
```

For `host=local-web`, require `documentId`, install `window.desktop`, then dynamically import and mount the existing `App`. For Electron, preserve the current preload path. Without either, render an honest launch error.

- [ ] **Step 5: Gate native-only controls**

Expose `window.nexusdeskDocsHost.capabilities` and hide/disable File Open, Save As, encryption, print, Zotero, external-path attachments, and native provider settings in Web mode. The ordinary editor, in-place Save, undo/redo, review, layout, tables, charts, and AI panel remain visible.

- [ ] **Step 6: Run Docs adapter tests, selected lifecycle tests, and typecheck**

Run: `npm test -w @genoffice/docs -- browser-host-api open-file doc-dirty save-until-persisted && npm run typecheck -w @genoffice/docs`

Expected: PASS with Electron host selection unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/docs
git commit -m "feat: add Docs browser Host adapter"
```

### Task 5: Build Docs for Web and route it from the shared Shell

**Files:**

- Create: `apps/docs/vite.renderer.config.ts`
- Create: `apps/docs/tests/vite-renderer-config.test.ts`
- Modify: `apps/docs/package.json`
- Modify: `apps/web/src/web-office-host.ts`
- Modify: `apps/web/tests/web-office-host.test.ts`
- Modify: `packages/nexusdesk-shell-ui/src/product-config.ts`
- Modify: `packages/nexusdesk-shell-ui/src/AppFrame.tsx`
- Modify: `packages/nexusdesk-shell-ui/tests/render.test.tsx`
- Modify: `apps/local-host/src/main.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: Docs browser entry from Task 4 and editor-root routing from Task 1.
- Produces: `/docs/` Web assets, `editorRoute('docs', id)`, Docs in Web capabilities/product config, and root `build:web` output containing Shell + Docs + Sheets.

- [ ] **Step 1: Write failing route/build configuration tests**

```ts
it('routes a Docs tab to the shared renderer with an authorized id', () => {
  expect(editorRoute({ editorType: 'docs', documentId: 'doc 1' })).toBe(
    '/docs/?host=local-web&documentId=doc%201',
  )
})

it('proxies Local Host APIs only in explicit local Web development mode', () => {
  expect(createRendererServerOptions({ NEXUSDESK_LOCAL_WEB: '1', NEXUSDESK_LOCAL_ORIGIN: origin }))
    .toMatchObject({ proxy: { '/api': { target: origin }, '/ws': { ws: true } } })
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @genoffice/docs -- vite-renderer-config && npm test -w @nexusdesk/shell-ui && npm test -w @nexusdesk/web`

Expected: FAIL because Docs has no Web build and the Shell advertises only Sheets.

- [ ] **Step 3: Add the Vite Web build**

Use `root: 'src/renderer'`, `base: '/docs/'`, React plugin, Local Host `/api` and `/ws` proxy, and `outDir: '../../out/web'`. Add `build:web` to `@genoffice/docs` and include it before `@nexusdesk/web` in the root build sequence.

- [ ] **Step 4: Enable Docs only after its route exists**

Set browser capabilities to `editors: ['docs', 'sheets']`, map `.docx` files to Docs cards, and keep one mounted iframe per open Docs tab using the same hidden-not-unmounted behavior as Sheets.

- [ ] **Step 5: Run Web/Shell/Docs builds and tests**

Run: `npm test -w @genoffice/docs -- browser-host-api vite-renderer-config && npm test -w @nexusdesk/shell-ui && npm test -w @nexusdesk/web && npm run build:web`

Expected: PASS and `apps/docs/out/web/index.html` exists with `/docs/` asset URLs.

- [ ] **Step 6: Commit**

```bash
git add apps/docs apps/web apps/local-host packages/nexusdesk-shell-ui package.json package-lock.json
git commit -m "feat: serve Docs in the shared Web Shell"
```

### Task 6: Extract the Docs DSL executor and add a NexusDesk editor adapter

**Files:**

- Create: `apps/docs/src/renderer/agent/docs-command-executor.ts`
- Create: `apps/docs/src/renderer/agent/docs-editor-adapter.ts`
- Create: `apps/docs/src/renderer/agent/browser-agent-api.ts`
- Create: `apps/docs/tests/docs-command-executor.test.ts`
- Create: `apps/docs/tests/docs-editor-adapter.test.ts`
- Create: `apps/docs/tests/browser-agent-api.test.ts`
- Modify: `apps/docs/src/renderer/mcp-bridge.ts`
- Modify: `apps/docs/src/renderer/App.tsx`

**Interfaces:**

- Consumes: existing Docs `read_document`, `insert_content`, `replace_blocks`, and `apply_ops` executors; `EditorAdapter`; the browser host handle from Task 4.
- Produces: `executeDocsCommand(context, command, payload)`, `createDocsEditorAdapter(context)`, proposal hashing/summaries, exact approval binding, verification, save, and operation replay.

- [ ] **Step 1: Write failing transport-neutral executor tests**

```ts
it('executes read_document and apply_ops without MCP message objects', async () => {
  const read = await executeDocsCommand(context, 'read_document', { scope: 'document' })
  expect(read).toMatchObject({ ok: true, result: expect.objectContaining({ blocks: expect.any(Array) }) })
  const edit = await executeDocsCommand(context, 'apply_ops', {
    operations: [{ op: 'insert_text', blockId: 'p1', offset: 0, text: 'Approved ' }],
  })
  expect(edit).toMatchObject({ ok: true })
})
```

- [ ] **Step 2: Verify executor RED**

Run: `npm test -w @genoffice/docs -- docs-command-executor`

Expected: FAIL because execution is embedded in `mcp-bridge.ts`.

- [ ] **Step 3: Extract execution and keep MCP as a wrapper**

Move only command dispatch/context code; retain `onMcpCommand/reportMcpResult/signalMcpReady` inside the compatibility bridge. Both transports must receive the same sanitized result and error normalization.

- [ ] **Step 4: Write failing adapter/approval/replay tests**

```ts
it('binds apply to the exact proposed hash and consumes approval once', async () => {
  const plan = await adapter.propose(editRequest)
  await expect(adapter.apply({ ...plan, planHash: 'wrong', approvalId: 'a1' })).resolves.toMatchObject({
    ok: false,
    warnings: expect.arrayContaining([expect.objectContaining({ code: 'APPROVAL_INVALID' })]),
  })
  approvalStore.approve('a1', plan.planHash)
  await expect(adapter.apply({ ...plan, approvalId: 'a1' })).resolves.toMatchObject({ ok: true })
  await expect(adapter.apply({ ...plan, approvalId: 'a1' })).resolves.toMatchObject({ ok: false })
})

it('replays a journaled operation result without running the command again', async () => {
  bridge.receive(applyFrame)
  await flushPromises()
  bridge.receive(applyFrame)
  await flushPromises()
  expect(context.applyCount).toBe(1)
  expect(sentResults).toHaveLength(2)
  expect(sentResults[1]).toEqual(sentResults[0])
})
```

- [ ] **Step 5: Implement bounded plans and Agent-facing results**

Canonicalize JSON before SHA-256 hashing. Bound a plan to 200 operations, 200 targets, 100 warnings, and a 256 KiB serialized payload. Map editor outcomes to `AgentToolResult` with summary, target/count changes, warnings, verification issues, and transaction id only. Attach the adapter after the active Docs editor/context is ready; detach it on teardown.

- [ ] **Step 6: Run focused and full Docs suites**

Run: `npm test -w @genoffice/docs -- docs-command-executor docs-editor-adapter browser-agent-api mcp-bridge agent-docs && npm test -w @genoffice/docs`

Expected: PASS with existing MCP compatibility and built-in AI tests unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/docs
git commit -m "feat: add native NexusDesk Docs adapter"
```

### Task 7: Register Docs tools in the Harness runtime

**Files:**

- Create: `packages/nexusdesk-runtime-host/src/docs-tools.ts`
- Create: `packages/nexusdesk-runtime-host/tests/docs-tools.test.ts`
- Modify: `packages/nexusdesk-runtime-host/src/index.ts`
- Modify: `packages/nexusdesk-runtime-host/src/runtime-policy.ts`
- Modify: `packages/nexusdesk-runtime-host/tests/runtime-policy.test.ts`
- Modify: `packages/nexusdesk-runtime-host/tests/runtime-smoke.mjs`

**Interfaces:**

- Consumes: the editor request bridge and approval API used by Sheets, plus Docs commands from Task 6.
- Produces: `read_document`, `apply_document_operations`, and `save_document`, selected by the active session's `editorType`.

- [ ] **Step 1: Write failing tool tests**

```ts
it('proposes, requests exact approval, and applies one Docs DSL batch', async () => {
  const tools = createDocsTools(bridge)
  const result = await runTool(tools, 'apply_document_operations', { operations })
  expect(bridge.requests.map((request) => request.command)).toEqual(['propose_ops', 'apply_ops'])
  expect(bridge.approvals[0]).toMatchObject({ toolName: 'apply_document_operations', proposal: { planHash } })
  expect(result).toMatchObject({ ok: true, summary: expect.any(String) })
})

it('returns only AgentToolResult fields', async () => {
  const result = await runTool(createDocsTools(bridge), 'read_document', { scope: 'document' })
  expect(result).not.toHaveProperty('editor')
  expect(result).not.toHaveProperty('engine')
  expect(result).not.toHaveProperty('webContents')
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @nexusdesk/runtime-host -- docs-tools runtime-policy`

Expected: FAIL because only Sheets tools are registered.

- [ ] **Step 3: Implement editor-specific tool catalogs**

Add `editorType` to runtime `agent:start` targeting. Register exactly one catalog per session/editor: Docs uses `read_document`, `apply_document_operations`, `save_document`; Sheets retains its three tools. Reject unknown editor kinds, unknown commands, malformed proposal data, denied approvals, and missing active targets.

- [ ] **Step 4: Build and smoke the isolated runtime**

Run: `npm test -w @nexusdesk/runtime-host && npm run build -w @nexusdesk/runtime-host && npm run smoke -w @nexusdesk/runtime-host`

Expected: PASS; the smoke test sees the Docs tool names only for a Docs session and Sheets tool names only for a Sheets session.

- [ ] **Step 5: Commit**

```bash
git add packages/nexusdesk-runtime-host
git commit -m "feat: register native Docs Harness tools"
```

### Task 8: Prove the complete Docs workflow and document it

**Files:**

- Create: `tests/local-web-docs.spec.ts`
- Create: `tests/fixtures/nexusdesk-docs-source.docx`
- Modify: `playwright.local-web.config.ts`
- Modify: `scripts/run-local-web-e2e.mjs`
- Modify: `apps/local-host/tests/server.test.ts`
- Modify: `README.md`
- Modify: `docs/nexusdesk-local-web.md`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: all Tasks 1-7.
- Produces: a real Chromium acceptance flow and operator documentation for Docs + Sheets.

- [ ] **Step 1: Write the failing Chromium acceptance test**

```ts
test('authenticated browser edits and saves one approved Docs operation across reload', async ({ page }) => {
  await page.goto(bootstrapUrl)
  await page.getByRole('button', { name: /nexusdesk-docs-source\.docx/i }).click()
  const frame = page.frameLocator('iframe[title="nexusdesk-docs-source.docx"]')
  await frame.locator('.ProseMirror').click()
  await frame.locator('.ProseMirror').pressSequentially('Manual edit. ')
  await runApprovedDocsTool(page, {
    operations: [{ op: 'insert_text', blockId: firstParagraphId, offset: 0, text: 'Agent edit. ' }],
  })
  await frame.getByRole('button', { name: /save/i }).click()
  await page.reload()
  await expect(frame.locator('.ProseMirror')).toContainText('Manual edit.')
  await expect(frame.locator('.ProseMirror')).toContainText('Agent edit.')
  expect(await frame.locator('.ProseMirror').getByText('Agent edit.', { exact: false }).count()).toBe(1)
})
```

- [ ] **Step 2: Verify E2E RED**

Run: `npm run test:e2e:local-web -- --grep Docs`

Expected: FAIL at the first missing/broken Docs product boundary, while the existing Sheets E2E remains runnable.

- [ ] **Step 3: Complete the production runner and documentation**

Build Docs Web assets, start the real Local Host with a copied DOCX fixture and real Harness runtime, launch the authenticated bootstrap URL, and clean only the E2E temporary directory. Document supported Web Docs behavior, typed native-only limits, binary/revision semantics, multi-provider Harness ownership, troubleshooting, and Electron compatibility.

- [ ] **Step 4: Run the Docs and Sheets E2E suite**

Run: `npm run test:e2e:local-web`

Expected: PASS for both the existing Sheets test and the new Docs test.

- [ ] **Step 5: Run the complete milestone gate**

Run: `npm test -w @nexusdesk/office-host && npm test -w @nexusdesk/protocol && npm test -w @nexusdesk/runtime-host && npm test -w @nexusdesk/web-client && npm test -w @nexusdesk/local-host && npm test -w @nexusdesk/web && npm test -w @nexusdesk/shell-ui && npm test -w @genoffice/shell && npm test -w @genoffice/docs && npm test -w @genoffice/sheets -- sheets-command sheets-adapter browser-host-api revision-tracker mcp-bridge-ops && npm run build -w @nexusdesk/runtime-host && npm run smoke -w @nexusdesk/runtime-host && npm run build:web && npm run build -w @genoffice/shell && npm run test:e2e:local-web && npm run typecheck && npm run lint && npm run format:check && git diff --check`

Expected: PASS with zero test/type/build/format errors; lint may report only the pre-existing React Hook warnings already present at plan start.

- [ ] **Step 6: Commit**

```bash
git add tests scripts playwright.local-web.config.ts README.md docs .gitignore
git commit -m "test: verify NexusDesk Docs local Web workflow"
```
