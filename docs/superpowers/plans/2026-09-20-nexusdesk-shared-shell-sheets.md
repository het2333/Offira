# NexusDesk Shared Shell and Sheets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary NexusDesk Web page with the existing GenOffice Shell UI, backed by real Local Host services and the completed Sheets + Harness native Tool flow, while keeping Electron compatible with the same shared frontend.

**Architecture:** Extract the browser-safe Shell renderer into a shared workspace package and inject a typed `OfficeHost` instead of reading Electron globals. The Web implementation calls authenticated Local Host HTTP/WebSocket services; Electron uses a compatibility adapter for platform-only behavior while document and Agent authority remain in the Local Host.

**Tech Stack:** TypeScript 5.9, React 19, Vite 7, Node HTTP/WebSocket, Zod, Vitest, Playwright Chromium, Electron 43, existing GenOffice editor renderers, DeepSeek Harness runtime host.

**Spec:** `docs/superpowers/specs/2026-09-20-nexusdesk-shared-frontend-native-shell-design.md`

## Global Constraints

- Reuse the existing GenOffice Shell appearance and interactions; do not create a second NexusDesk design.
- Browser UI imports no Electron, Node, filesystem, Harness, or editor-engine module.
- The Local Host owns documents, tabs, persisted Shell state, Harness sessions, approvals, revisions, and recovery.
- Web and Electron consume one shared UI and one product-owned host contract.
- Unsupported platform operations are capability-gated and never report fake success.
- NexusDesk exposes no MCP product bridge or MCP settings UI.
- Harness retains multi-provider support but loads only bundled official Office tools.
- Tool results remain bounded, serializable, Agent-facing values.
- Development supports current Chromium and the Codex built-in browser; direct `file://` launch is not a supported runtime.
- This plan completes the shared Shell + Sheets milestone. Docs, Slides, PDF, Markdown, HTML, credential UI, signed packaging, native Swift/WinUI shells, and collaboration use later plans against the frozen contract.

## Review Focus

- Refreshing an editor route must restore the same Host-owned tab and document instead of duplicating it; Task 7 adds the integration test.
- A browser that calls a hidden or unsupported desktop action must receive `UNSUPPORTED_CAPABILITY`, not success; Tasks 1, 3, and 6 add contract and UI tests.
- An authenticated browser must not operate on a path that the Host did not authorize; Task 2 adds authorization tests.
- A disconnected/reconnected Sheets iframe must preserve the operation journal and must not repeat an approved edit; Task 10 extends the Chromium E2E.
- Electron and Web adapters must expose compatible Shell semantics even when platform capabilities differ; Tasks 3 and 8 add a shared conformance suite.

---

### Task 1: Define the Office Host contract and runtime schemas

**Files:**

- Create: `packages/nexusdesk-office-host/package.json`
- Create: `packages/nexusdesk-office-host/tsconfig.json`
- Create: `packages/nexusdesk-office-host/vitest.config.ts`
- Create: `packages/nexusdesk-office-host/src/index.ts`
- Create: `packages/nexusdesk-office-host/src/schemas.ts`
- Create: `packages/nexusdesk-office-host/tests/schemas.test.ts`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: `EditorType`, `DocumentId`, and `Revision` from `@nexusdesk/protocol`.
- Produces: `OfficeHost`, `HostCapabilities`, `ShellBootstrap`, `ShellDocumentSummary`, `ShellTabSummary`, `ProductConfig`, `HostError`, and Zod schemas for every HTTP payload used later.

- [ ] **Step 1: Write the failing schema tests**

```ts
it('rejects unsupported editor kinds and duplicate tab ids', () => {
  expect(() =>
    shellBootstrapSchema.parse({
      capabilities: baseCapabilities,
      documents: [{ documentId: 'd1', title: 'Book.xlsx', editorType: 'unknown', revision: 0 }],
      tabs: [],
      settings: { language: 'zh', theme: 'system', onboardingSeen: true },
    }),
  ).toThrow()
  expect(() =>
    shellBootstrapSchema.parse({
      capabilities: baseCapabilities,
      documents: [],
      tabs: [homeTab, homeTab],
      settings: { language: 'zh', theme: 'system', onboardingSeen: true },
    }),
  ).toThrow(/duplicate/i)
})

it('represents unsupported platform actions explicitly', () => {
  expect(
    hostErrorSchema.parse({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'Unavailable in browser mode',
      retryable: false,
    }),
  ).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -w @nexusdesk/office-host`

Expected: FAIL because the workspace package and schemas do not exist.

- [ ] **Step 3: Implement the minimal contract**

```ts
export type EditorKind = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'

export interface HostCapabilities {
  mode: 'browser' | 'electron'
  editors: readonly EditorKind[]
  nativeFilePicker: boolean
  browserImport: boolean
  revealInFileManager: boolean
  trash: boolean
  updater: boolean
  credentialStore: boolean
}

export interface OfficeHost {
  bootstrap(): Promise<ShellBootstrap>
  files: FileService
  documents: DocumentService
  tabs: TabService
  settings: SettingsService
  agent: AgentService
  platform: PlatformService
}
```

Define immutable summaries without engine objects or raw Harness payloads. Add `.superRefine` checks for unique document and tab IDs, exactly one active tab, Home pinned at index zero, and tabs referencing known documents.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `npm test -w @nexusdesk/office-host && npm run typecheck -w @nexusdesk/office-host`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nexusdesk-office-host package-lock.json
git commit -m "feat: define NexusDesk Office Host contract"
```

### Task 2: Add real Local Host Shell state and authorized-file services

**Files:**

- Create: `apps/local-host/src/shell-state.ts`
- Create: `apps/local-host/src/authorized-files.ts`
- Create: `apps/local-host/src/app-data.ts`
- Create: `apps/local-host/tests/shell-state.test.ts`
- Create: `apps/local-host/tests/authorized-files.test.ts`
- Modify: `apps/local-host/src/server.ts`
- Modify: `apps/local-host/src/main.ts`
- Modify: `apps/local-host/package.json`

**Interfaces:**

- Consumes: `ShellBootstrap`, `ShellDocumentSummary`, `ShellTabSummary`, and request schemas from Task 1; production `LocalDocument` records.
- Produces: `ShellState`, `AuthorizedFiles`, and authenticated `/api/shell/bootstrap`, `/api/shell/tabs/*`, `/api/shell/settings`, `/api/shell/files/*` routes.

- [ ] **Step 1: Write failing service tests**

```ts
it('keeps one home tab and one tab per registered document across page refreshes', async () => {
  const state = await ShellState.open({ path, documents: [workbook] })
  await state.activate(`document:${workbook.documentId}`)
  const reopened = await ShellState.open({ path, documents: [workbook] })
  expect(reopened.bootstrap().tabs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'home', kind: 'home' }),
      expect.objectContaining({ documentId: workbook.documentId, active: true }),
    ]),
  )
})

it('rejects file ids outside the authorized registry', () => {
  const files = new AuthorizedFiles([workbook])
  expect(() => files.require('file-not-authorized')).toThrowError(
    expect.objectContaining({ code: 'FILE_NOT_AUTHORIZED' }),
  )
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @nexusdesk/local-host -- shell-state authorized-files`

Expected: FAIL because the services do not exist.

- [ ] **Step 3: Implement atomic persisted Shell state**

Use an injected state path in tests and the OS application-data directory in production. Write `<state>.tmp`, `fsync` the file, and rename over the target. Persist only tab order/activation and non-secret settings. Merge registered documents on startup and drop tabs whose documents are no longer authorized.

```ts
export class ShellState {
  static open(options: ShellStateOptions): Promise<ShellState>
  bootstrap(capabilities: HostCapabilities): ShellBootstrap
  activate(tabId: string): Promise<ShellBootstrap>
  close(tabId: string): Promise<ShellBootstrap>
  reorder(tabId: string, toIndex: number): Promise<ShellBootstrap>
  updateSettings(patch: ShellSettingsPatch): Promise<ShellBootstrap>
}
```

- [ ] **Step 4: Add authenticated routes with schema validation**

Route mutations only after the existing cookie, Host, and Origin checks. Return structured `HostError` JSON. Resolve file operations through `AuthorizedFiles`; never accept a raw request path.

- [ ] **Step 5: Run service and Local Host suites**

Run: `npm test -w @nexusdesk/local-host && npm run typecheck -w @nexusdesk/local-host`

Expected: PASS, including unauthorized file IDs and corrupt persisted-state recovery.

- [ ] **Step 6: Commit**

```bash
git add apps/local-host package-lock.json
git commit -m "feat: add Local Host Shell services"
```

### Task 3: Implement the browser Office Host adapter and conformance suite

**Files:**

- Create: `packages/nexusdesk-office-host/src/conformance.ts`
- Create: `apps/web/src/web-office-host.ts`
- Create: `apps/web/tests/web-office-host.test.ts`
- Create: `apps/web/tests/office-host-conformance.test.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/tsconfig.json`

**Interfaces:**

- Consumes: `OfficeHost` and runtime schemas from Task 1; Local Host endpoints from Task 2; existing authenticated WebSocket client behavior.
- Produces: `createWebOfficeHost(fetch, socketFactory): OfficeHost` and `officeHostConformance(factory)` reusable by Task 8.

- [ ] **Step 1: Write failing adapter tests**

```ts
it('parses bootstrap and sends tab mutations to the Host', async () => {
  const requests: string[] = []
  const host = createWebOfficeHost(fakeFetch(requests), fakeSocket)
  await expect(host.bootstrap()).resolves.toMatchObject({ tabs: [{ id: 'home' }] })
  await host.tabs.activate('document:d1')
  expect(requests).toContain('/api/shell/tabs/activate')
})

it('throws a typed unsupported-capability error without issuing a request', async () => {
  const host = createWebOfficeHost(fakeFetchWithBrowserCapabilities(), fakeSocket)
  await expect(host.platform.revealFile('f1')).rejects.toMatchObject({
    code: 'UNSUPPORTED_CAPABILITY',
  })
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @nexusdesk/web -- web-office-host office-host-conformance`

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement validated HTTP and event calls**

All fetches use `credentials: 'same-origin'`, validate response schemas, convert non-2xx JSON into `HostError`, and never return an unchecked cast. Event subscriptions reconnect and refresh Host state after sequence gaps.

- [ ] **Step 4: Run Web adapter tests and typecheck**

Run: `npm test -w @nexusdesk/web && npm run typecheck -w @nexusdesk/web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web packages/nexusdesk-office-host package-lock.json
git commit -m "feat: add Web Office Host adapter"
```

### Task 4: Make the existing Shell renderer host-injected

**Files:**

- Create: `apps/shell/src/renderer/src/office-host-context.tsx`
- Create: `apps/shell/tests/office-host-context.test.tsx`
- Modify: `apps/shell/src/renderer/src/AppFrame.tsx`
- Modify: `apps/shell/src/renderer/src/Home.tsx`
- Modify: `apps/shell/src/renderer/src/Onboarding.tsx`
- Modify: `apps/shell/src/renderer/src/SettingsModal.tsx`
- Modify: `apps/shell/src/renderer/src/StarPromptCard.tsx`
- Modify: `apps/shell/src/renderer/src/TabBar.tsx`
- Modify: `apps/shell/src/renderer/src/locale.tsx`
- Modify: `apps/shell/src/renderer/src/main.tsx`
- Modify: `apps/shell/package.json`

**Interfaces:**

- Consumes: `OfficeHost` from Task 1 and the existing Electron preload APIs.
- Produces: `OfficeHostProvider` and `useOfficeHost`; all existing Shell components consume services through the provider while remaining in their current app.

- [ ] **Step 1: Write failing provider and source-boundary tests**

```tsx
it('reads the injected host and fails clearly without a provider', () => {
  expect(() => renderHook(() => useOfficeHost())).toThrow(/OfficeHostProvider/)
  const host = fakeOfficeHost()
  const wrapper = ({ children }: PropsWithChildren) => (
    <OfficeHostProvider host={host}>{children}</OfficeHostProvider>
  )
  expect(renderHook(() => useOfficeHost(), { wrapper }).result.current).toBe(host)
})

it('keeps product components independent of Electron globals', async () => {
  const sources = await readShellProductSources()
  expect(sources).not.toMatch(/window\.aiOffice|window\.aiOfficeTabs|window\.aiOfficeIntegrations/)
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @genoffice/shell -- office-host-context`

Expected: FAIL because provider injection does not exist and product components read Electron globals.

- [ ] **Step 3: Implement the provider**

```tsx
const OfficeHostContext = createContext<OfficeHost | null>(null)

export function useOfficeHost(): OfficeHost {
  const host = useContext(OfficeHostContext)
  if (host === null) throw new Error('OfficeHostProvider is missing')
  return host
}
```

- [ ] **Step 4: Replace global calls service-by-service**

Use `host.tabs` in `AppFrame` and `TabBar`, `host.files` and `host.documents` in `Home`, `host.settings` in locale/settings/onboarding, and `host.platform` only behind capabilities. `main.tsx` is the sole composition root and may construct a temporary Electron-backed `OfficeHost`; product components may not read preload globals.

- [ ] **Step 5: Run Shell tests and typecheck**

Run: `npm test -w @genoffice/shell && npm run typecheck -w @genoffice/shell`

Expected: PASS with the existing Electron UI behavior preserved.

- [ ] **Step 6: Commit**

```bash
git add apps/shell package-lock.json
git commit -m "refactor: inject Office Host into GenOffice Shell"
```

### Task 5: Extract the host-neutral renderer into a shared package

**Files:**

- Create: `packages/nexusdesk-shell-ui/package.json`
- Create: `packages/nexusdesk-shell-ui/tsconfig.json`
- Create: `packages/nexusdesk-shell-ui/vitest.config.ts`
- Move: `apps/shell/src/renderer/src/{AppFrame.tsx,Home.tsx,Onboarding.tsx,SettingsModal.tsx,StarPromptCard.tsx,TabBar.tsx,locale.tsx,office-host-context.tsx,provider-logos.tsx,strings.ts}` to `packages/nexusdesk-shell-ui/src/`
- Move: `apps/shell/src/renderer/src/{home.css,onboarding.css,settings.css,star-prompt.css,tabbar.css}` to `packages/nexusdesk-shell-ui/src/`
- Move: referenced renderer assets to `packages/nexusdesk-shell-ui/src/assets/`
- Create: `packages/nexusdesk-shell-ui/src/index.ts`
- Create: `packages/nexusdesk-shell-ui/tests/render.test.tsx`
- Create: `packages/nexusdesk-shell-ui/tests/no-platform-imports.test.ts`
- Modify: `apps/shell/src/renderer/src/main.tsx`
- Modify: `apps/shell/package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: the host-neutral components from Task 4, React, GenOffice UI/i18n packages, and `OfficeHost` from Task 1.
- Produces: `SharedShell`, `OfficeHostProvider`, `useOfficeHost`, and shared Shell styles consumed by Web and Electron.

- [ ] **Step 1: Write a failing shared-package render test**

```tsx
it('renders the original home and tab chrome through an injected host', async () => {
  render(
    <OfficeHostProvider host={fakeOfficeHost()}>
      <SharedShell />
    </OfficeHostProvider>,
  )
  expect(await screen.findByText('NexusDesk')).toBeVisible()
  expect(screen.getByRole('tab', { name: /home/i })).toBeVisible()
  expect(screen.getByText('Forecast.xlsx')).toBeVisible()
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @nexusdesk/shell-ui`

Expected: FAIL because the shared workspace package does not exist.

- [ ] **Step 3: Move the existing UI without visual rewrites**

Use `git mv` for every listed source, style, and asset so history remains reviewable. Keep CSS class names and DOM structure stable. Export one `SharedShell` entry and do not copy the files back into `apps/web`.

- [ ] **Step 4: Add the privileged-import boundary test**

```ts
it('contains no Electron global or privileged import', async () => {
  const sources = await readSharedShellSources()
  expect(sources).not.toMatch(/window\.aiOffice|from ['"]electron['"]|node:/)
})
```

- [ ] **Step 5: Run shared UI and Electron checks**

Run: `npm test -w @nexusdesk/shell-ui && npm run typecheck -w @nexusdesk/shell-ui && npm test -w @genoffice/shell && npm run typecheck -w @genoffice/shell`

Expected: PASS; the Electron entry imports the shared package and no moved product component imports a privileged runtime.

- [ ] **Step 6: Commit**

```bash
git add apps/shell packages/nexusdesk-shell-ui package-lock.json
git commit -m "refactor: extract shared GenOffice Shell UI"
```

### Task 6: Add NexusDesk product configuration and honest capability gating

**Files:**

- Create: `packages/nexusdesk-shell-ui/src/product-config.ts`
- Create: `packages/nexusdesk-shell-ui/src/UnsupportedAction.tsx`
- Create: `packages/nexusdesk-shell-ui/tests/capabilities.test.tsx`
- Modify: `packages/nexusdesk-shell-ui/src/Home.tsx`
- Modify: `packages/nexusdesk-shell-ui/src/SettingsModal.tsx`
- Modify: `packages/nexusdesk-shell-ui/src/TabBar.tsx`
- Modify: `packages/nexusdesk-shell-ui/src/AppFrame.tsx`

**Interfaces:**

- Consumes: `ProductConfig` and `HostCapabilities` from Task 1.
- Produces: `NEXUSDESK_PRODUCT_CONFIG` with MCP/integrations/cloud hidden, Sheets enabled, and unsupported native actions gated.

- [ ] **Step 1: Write failing capability tests**

```tsx
it('does not render MCP or unsupported reveal/trash actions in NexusDesk browser mode', async () => {
  renderShell({ capabilities: browserCapabilities, config: NEXUSDESK_PRODUCT_CONFIG })
  expect(screen.queryByText(/MCP/i)).not.toBeInTheDocument()
  await userEvent.click(await screen.findByText('Forecast.xlsx'))
  expect(screen.queryByRole('menuitem', { name: /reveal/i })).not.toBeInTheDocument()
})

it('surfaces an unsupported error if a stale UI invokes a gated action', async () => {
  await expect(browserHost.platform.revealFile('f1')).rejects.toMatchObject({
    code: 'UNSUPPORTED_CAPABILITY',
  })
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @nexusdesk/shell-ui -- capabilities`

Expected: FAIL because product configuration is not applied.

- [ ] **Step 3: Implement product and capability gates**

Do not render MCP, cloud projects, account login, updater, reveal, trash, or native menu actions unless both product configuration and Host capability enable them. Keep theme, language, onboarding, recents, tabs, opening authorized documents, and Sheets creation/opening backed by real services.

- [ ] **Step 4: Run shared UI tests and typecheck**

Run: `npm test -w @nexusdesk/shell-ui && npm run typecheck -w @nexusdesk/shell-ui`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nexusdesk-shell-ui
git commit -m "feat: configure shared Shell for NexusDesk"
```

### Task 7: Implement Host-owned tabs and shared editor routing

**Files:**

- Create: `packages/nexusdesk-shell-ui/src/EditorFrame.tsx`
- Create: `packages/nexusdesk-shell-ui/tests/editor-frame.test.tsx`
- Modify: `packages/nexusdesk-shell-ui/src/AppFrame.tsx`
- Modify: `apps/local-host/src/shell-state.ts`
- Modify: `apps/local-host/src/server.ts`
- Modify: `apps/local-host/tests/server.test.ts`
- Modify: `apps/web/src/bootstrap.ts`
- Modify: `apps/web/tests/bootstrap.test.ts`

**Interfaces:**

- Consumes: Host tab/document summaries and existing `/sheets/?host=local-web&documentId=...` route.
- Produces: one active editor iframe keyed by Host tab state and refresh-safe activate/close/reorder behavior.

- [ ] **Step 1: Write failing routing tests**

```tsx
it('renders the active Sheets document without duplicating it after bootstrap refresh', async () => {
  const host = fakeOfficeHost({ activeDocument: workbook })
  const { rerender } = renderSharedShell(host)
  expect(screen.getByTitle('Forecast.xlsx')).toHaveAttribute(
    'src',
    '/sheets/?host=local-web&documentId=d1',
  )
  rerender(renderSharedShell(await host.reconnect()))
  expect(screen.getAllByTitle('Forecast.xlsx')).toHaveLength(1)
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @nexusdesk/shell-ui -- editor-frame && npm test -w @nexusdesk/local-host -- server`

Expected: FAIL because the shared frame and tab mutation routes are incomplete.

- [ ] **Step 3: Implement editor route mapping**

```ts
export function editorRoute(document: ShellDocumentSummary): string {
  if (document.editorType === 'sheets') {
    return `/sheets/?host=local-web&documentId=${encodeURIComponent(document.documentId)}`
  }
  throw new HostError(
    'EDITOR_NOT_AVAILABLE',
    `${document.editorType} is not available in this build`,
    false,
  )
}
```

Render only the active editor. Keep inactive tab identity in Host state, not mounted hidden iframes. Add accessible loading and editor-unavailable states.

- [ ] **Step 4: Run routing, Host, and Web tests**

Run: `npm test -w @nexusdesk/shell-ui && npm test -w @nexusdesk/local-host && npm test -w @nexusdesk/web-client`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nexusdesk-shell-ui apps/local-host apps/web
git commit -m "feat: add Host-owned shared editor tabs"
```

### Task 8: Preserve Electron through an Office Host compatibility adapter

**Files:**

- Create: `apps/shell/src/renderer/src/electron-office-host.ts`
- Create: `apps/shell/tests/electron-office-host.test.ts`
- Modify: `apps/shell/src/renderer/src/main.tsx`
- Modify: `apps/shell/src/preload/index.ts`
- Modify: `apps/shell/src/shared/home-api.ts`
- Modify: `apps/shell/src/shared/tabs-api.ts`
- Modify: `apps/shell/package.json`

**Interfaces:**

- Consumes: existing Electron preload APIs and `OfficeHost` from Task 1.
- Produces: `createElectronOfficeHost(window): OfficeHost`, passing the same conformance cases as Web while advertising Electron-only capabilities truthfully.

- [ ] **Step 1: Add the Electron adapter to the conformance suite**

```ts
officeHostConformance(() => createElectronOfficeHost(fakePreloadWindow()))

it('advertises native platform capabilities without changing document semantics', async () => {
  const host = createElectronOfficeHost(fakePreloadWindow())
  expect((await host.bootstrap()).capabilities).toMatchObject({
    mode: 'electron',
    nativeFilePicker: true,
  })
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @genoffice/shell -- electron-office-host`

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement the compatibility adapter**

Map existing preload calls into semantic services. Do not move Local Host document or Agent authority into the adapter. Mark updater, reveal, trash, and native file picker true only when the preload implementation exists.

- [ ] **Step 4: Mount the shared Shell from Electron**

Resolve language, onboarding, theme, and bootstrap through `OfficeHost`, then render:

```tsx
<OfficeHostProvider host={host}>
  <SharedShell product={GENOFFICE_PRODUCT_CONFIG} />
</OfficeHostProvider>
```

- [ ] **Step 5: Run Shell tests, typecheck, and build**

Run: `npm test -w @genoffice/shell && npm run typecheck -w @genoffice/shell && npm run build -w @genoffice/shell`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/shell packages/nexusdesk-shell-ui
git commit -m "feat: host shared Shell in Electron"
```

### Task 9: Replace the temporary Web UI with the shared Shell

**Files:**

- Delete: `apps/web/src/App.tsx`
- Delete: `apps/web/src/styles.css`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/index.html`
- Create: `apps/web/src/file-launch-guard.ts`
- Create: `apps/web/tests/file-launch-guard.test.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/local-host/src/server.ts`

**Interfaces:**

- Consumes: `createWebOfficeHost`, `SharedShell`, and `NEXUSDESK_PRODUCT_CONFIG`.
- Produces: the production NexusDesk Web entry with the original GenOffice interface and a clear unsupported `file://` state.

- [ ] **Step 1: Write failing entry tests**

```ts
it('explains direct file launch instead of rendering an empty root', () => {
  expect(fileLaunchMessage(new URL('file:///repo/apps/web/index.html'))).toMatch(/start:web/i)
  expect(fileLaunchMessage(new URL('http://127.0.0.1:4000/'))).toBeUndefined()
})
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @nexusdesk/web -- file-launch-guard`

Expected: FAIL because the guard is missing.

- [ ] **Step 3: Mount the shared Shell**

Resolve the Host bootstrap before first paint, install GenOffice UI tokens/screentips, apply language and theme, and render the shared package. If `location.protocol === 'file:'`, render a static diagnostic explaining the supported `npm run start:web -- /absolute/file.xlsx` flow without attempting fetches.

- [ ] **Step 4: Build and inspect asset routing**

Run: `npm run build -w @nexusdesk/web && npm run build:web`

Expected: PASS; Local Host serves Shell assets at `/` and Sheets assets at `/sheets/` without collisions.

- [ ] **Step 5: Commit**

```bash
git add apps/web apps/local-host package-lock.json
git commit -m "feat: use shared GenOffice Shell on the Web"
```

### Task 10: Extend the real Chromium acceptance flow

**Files:**

- Modify: `e2e/local-web-sheets-agent.spec.ts`
- Modify: `e2e/helpers/local-web.ts`
- Modify: `e2e/fixtures/fake-harness-runtime.mjs`
- Test: `apps/local-host/tests/agent-router.test.ts`
- Test: `apps/sheets/tests/browser-host-api.test.ts`

**Interfaces:**

- Consumes: the complete shared Shell, Local Host, Sheets renderer, runtime fixture, approval protocol, and operation journals.
- Produces: acceptance evidence for home, tab, edit, save, refresh, reconnect, and idempotent Agent behavior.

- [ ] **Step 1: Change the E2E to expect the GenOffice Shell**

```ts
await expect(page.getByRole('tab', { name: /home/i })).toBeVisible()
await expect(page.getByText('Forecast.xlsx')).toBeVisible()
await page.getByText('Forecast.xlsx').first().dblclick()
await expect(page.getByRole('tab', { name: 'Forecast.xlsx' })).toHaveAttribute(
  'aria-selected',
  'true',
)
```

Continue through the existing formula/chart Agent operation, exact proposal approval, save approval, page reload, and terminal-result replay. Assert the adapter apply count remains one after reload.

- [ ] **Step 2: Run E2E and verify RED**

Run: `npm run test:e2e:local-web`

Expected: FAIL against the temporary Shell selectors before Task 9 is complete, or at the first missing shared-Shell lifecycle behavior.

- [ ] **Step 3: Fix only integration defects exposed by the acceptance flow**

Keep fixes in the owning Host, shared UI, or editor adapter; do not add E2E-only production branches or mock success.

- [ ] **Step 4: Run the E2E twice**

Run: `npm run test:e2e:local-web && npm run test:e2e:local-web`

Expected: both runs PASS with unique temporary workbooks and no leaked Host process.

- [ ] **Step 5: Commit**

```bash
git add e2e apps/local-host apps/sheets packages/nexusdesk-shell-ui apps/web
git commit -m "test: verify shared Shell Sheets workflow"
```

### Task 11: Document shared development and packaging boundaries

**Files:**

- Modify: `README.md`
- Modify: `docs/nexusdesk/local-web-development.md`
- Create: `docs/nexusdesk/office-host-contract.md`
- Modify: `docs/nexusdesk/editor-adapter.md`

**Interfaces:**

- Consumes: the implemented commands, capabilities, routes, and package ownership.
- Produces: contributor guidance that does not instruct direct `file://` launch or imply unimplemented editor/native capabilities.

- [ ] **Step 1: Update the startup and architecture docs**

Document:

```bash
npm run build:web
npm run start:web -- /absolute/path/to/Forecast.xlsx
```

Explain that Web and Electron mount the same Shell package, Local Host is the state authority, editor bundles remain isolated, direct `file://` is diagnostic-only, and Docs/Slides follow separate plans.

- [ ] **Step 2: Verify command and terminology accuracy**

Run: `rg -n "file://|start:web|OfficeHost|MCP|Electron" README.md docs/nexusdesk`

Expected: no instruction claims that opening source HTML runs the product; MCP is described only as legacy GenOffice compatibility, not NexusDesk transport.

- [ ] **Step 3: Run formatting and link-adjacent checks**

Run: `npm run format && npm run format:check && git diff --check`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/nexusdesk
git commit -m "docs: explain shared NexusDesk Shell"
```

### Task 12: Run the complete milestone gate and review the branch

**Files:**

- Modify only files required to fix failures caused by this plan.

**Interfaces:**

- Consumes: every deliverable from Tasks 1–11.
- Produces: a clean branch with fresh evidence suitable for whole-branch review.

- [ ] **Step 1: Run focused workspace suites**

```bash
npm test -w @nexusdesk/office-host
npm test -w @nexusdesk/shell-ui
npm test -w @nexusdesk/protocol
npm test -w @nexusdesk/runtime-host
npm test -w @nexusdesk/local-host
npm test -w @nexusdesk/web-client
npm test -w @nexusdesk/web
npm test -w @genoffice/shell
npm test -w @genoffice/sheets -- sheets-command sheets-adapter browser-host-api revision-tracker mcp-bridge-ops
```

Expected: all PASS.

- [ ] **Step 2: Run production and acceptance gates**

```bash
npm run build -w @nexusdesk/runtime-host
npm run smoke -w @nexusdesk/runtime-host
npm run build:web
npm run build -w @genoffice/shell
npm run test:e2e:local-web
```

Expected: all PASS.

- [ ] **Step 3: Run repository quality gates**

```bash
npm run typecheck
npm run lint
npm run format:check
git diff --check
```

Expected: all PASS with no new lint errors.

- [ ] **Step 4: Inspect product boundaries**

Run:

```bash
rg -n "window\.aiOffice|from ['\"]electron['\"]|node:" packages/nexusdesk-shell-ui/src
rg -n "McpServerSection|MCP" packages/nexusdesk-shell-ui/src
git status --short
```

Expected: the first command has no matches; NexusDesk product configuration does not render MCP; status contains only intended milestone changes.

- [ ] **Step 5: Commit final gate fixes**

```bash
git add -u
git commit -m "fix: complete shared Shell milestone gate"
```

- [ ] **Step 6: Request one whole-branch review**

Review the range from `1d4cf98` through `HEAD` against the spec and this plan. Address Critical and Important findings in one fix pass, rerun the complete gate, and record any intentionally deferred Minor findings before branch integration.
