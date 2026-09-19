# NexusDesk Shared Frontend and Native Shell Design

## Status

Approved architectural direction, awaiting written-spec review. This design replaces the temporary minimal NexusDesk Web Shell with the existing GenOffice product interface while preserving the Local Host and Harness integration already proven by the Sheets reference slice.

## Product intent

NexusDesk should have one recognizable Office interface across browser development, Electron desktop releases, and possible future native macOS or Windows shells. The existing GenOffice home screen, file cards, tab strip, settings, and editor renderers are the visual and interaction baseline. NexusDesk must not maintain a separate simplified Web product UI.

The shared frontend remains browser technology. Privileged behavior belongs behind stable host contracts. The first distributable desktop application uses Electron because the repository already contains its packaging, updater, window, and system-integration infrastructure. A future Swift/AppKit or WinUI shell may replace Electron without replacing the Office frontend, editor adapters, Local Host, Harness runtime, or Agent tools.

## Confirmed requirements

- Reuse the existing GenOffice Shell appearance and interactions instead of redesigning them.
- Keep one implementation of the home screen, file cards, tabs, settings, theme, localization, and editor chrome.
- Keep one browser-compatible renderer for each editor.
- Use the Local Host as the authority for documents, persistence, Harness sessions, approvals, revisions, and recovery.
- Preserve DeepSeek Harness multi-provider support while exposing only bundled official Office tools.
- Keep GenOffice editor DSLs and return product-owned, Agent-facing Tool results rather than engine objects.
- Support Chromium and the Codex built-in browser during development.
- Package the same frontend as a desktop application with Electron first.
- Allow a later native desktop shell to replace Electron through a platform adapter.
- Prepare document and operation identities for future collaboration without implementing collaboration now.

## Non-goals

- Rewriting Docs, Sheets, or Slides rendering in Swift, AppKit, WinUI, or another native UI toolkit.
- Maintaining separate Web and desktop versions of the product interface.
- Reproducing Electron-only behavior with fake Web success states.
- Exposing MCP as a NexusDesk product bridge or showing the existing MCP settings UI in NexusDesk builds.
- Implementing accounts, remote storage, real-time collaboration, or team permissions in the first shared-frontend milestone.
- Porting every editor in one implementation plan. Each editor after Sheets receives its own vertical-slice plan.
- Changing the existing editor engines or performing an unrelated visual redesign.

## Chosen architecture

NexusDesk uses a shared browser frontend, a product-owned host contract, and replaceable platform adapters.

```text
                    Shared GenOffice Frontend
        Home / File Cards / Tabs / Settings / Editor Chrome
                                  |
                         OfficeHost contract
                    _____________|_____________
                   |                           |
            WebHost adapter            Desktop adapter
          HTTP + WebSocket          platform capabilities
                   |                           |
                   |                    Electron today
                   |                 Swift/WinUI possible
                   |___________________________|
                                  |
                           NexusDesk Local Host
             documents / files / settings / Agent / recovery
                                  |
             pinned Harness runtime + official Office tools
                                  |
                  versioned editor adapter protocol
              Docs / Sheets / Slides / future editors
```

Electron is a delivery shell, not an application architecture. In a packaged build it starts the Local Host, opens an authenticated loopback URL in its window, and supplies only capabilities that genuinely require a desktop platform. Document and Agent behavior still travels through the same Local Host contracts used by browser development.

## Repository boundaries

The implementation will introduce or extract these ownership boundaries. Exact package names may be adjusted to match workspace naming conventions, but their responsibilities may not be merged back into a platform-specific application.

### Shared Shell UI

A browser-safe package extracted from `apps/shell/src/renderer/src` owns:

- home navigation and file views;
- file cards, recents, starred files, and folder presentation;
- tab strip and active-document presentation;
- settings, theme, language, onboarding, and shared dialogs;
- editor frame routing and loading, empty, disconnected, and error states.

It imports host contract types but no Electron, Node, filesystem, Harness, or editor-engine modules. It must not read `window.aiOffice` or `window.aiOfficeTabs` directly.

### Host contract

A product-owned package defines the browser-visible API:

```ts
interface OfficeHost {
  readonly capabilities: HostCapabilities
  readonly files: FileService
  readonly documents: DocumentService
  readonly tabs: TabService
  readonly settings: SettingsService
  readonly agent: AgentService
  readonly platform: PlatformService
}
```

The contract is semantic rather than a one-to-one copy of Electron IPC. Methods return serializable product types, use structured errors, and enforce bounded payloads. Event subscriptions return an unsubscribe function and carry monotonic sequence or revision values where ordering matters.

### Web Host adapter

The Web adapter implements the contract through authenticated Local Host HTTP endpoints and WebSocket events. It owns no product state beyond ephemeral request, loading, and UI preference state. Refreshing the page reconstructs documents, tabs, settings, and Agent sessions from the Host.

### Desktop platform adapter

The Electron adapter is deliberately narrow. It may provide:

- native open/save dialogs;
- window controls and application menus;
- Keychain or OS credential-store access through the Local Host;
- updater status and restart-to-update;
- reveal-in-file-manager and trash integration;
- desktop notifications and protocol activation.

It must not implement a second document registry, Agent router, operation journal, or settings truth. Those remain Local Host services. A future Swift/AppKit or WinUI adapter implements the same platform surface.

### Editor applications

Docs, Sheets, Slides, PDF, Markdown, and HTML remain independently built renderer applications. The shared Shell hosts the active editor using an isolated document route, initially an iframe in Web mode. Isolation prevents editor-global CSS, canvases, keyboard managers, and large dependencies from contaminating the Shell or each other.

Editors communicate with the Host through the versioned NexusDesk protocol and register their editor adapter explicitly. They never infer the target from the focused tab.

## Product configuration

The shared UI accepts a typed product configuration rather than forking components. NexusDesk configuration controls branding, supported editor kinds, provider settings, and feature visibility.

The NexusDesk configuration excludes GenOffice's MCP server controls and any action that cannot be backed by an allowed NexusDesk service. GenOffice can retain its existing configuration for upstream desktop behavior without introducing conditionals throughout visual components.

## Host capability negotiation

The Shell reads immutable launch capabilities before rendering actions. Capabilities distinguish product support from platform availability.

Examples include:

- native file picker;
- browser import/export;
- reveal in file manager;
- trash and restore;
- updater;
- OS credential store;
- editor kinds available in the current build;
- packaged desktop versus browser development.

Unavailable operations are hidden or visibly disabled with accurate explanatory copy. The UI must not simulate success or silently fall back to `localStorage`.

In browser development, documents may be supplied through a startup path registered by the Local Host or imported through a Chromium file handle/upload flow. In packaged desktop builds, the platform adapter uses native dialogs and path-backed documents. Both produce the same `DocumentSource` and `DocumentSummary` contracts for the Shell.

## File and document model

The Local Host remains authoritative for document identity and lifecycle. A document source is one of:

- a Host-authorized local path;
- a browser-imported working copy with an explicit export/write-back capability;
- a future managed or remote document reference.

The Shell never treats a browser display name as a filesystem path. Each open document has a stable `documentId`, editor type, title, source capability, committed revision, dirty state, save state, and owning editor connection.

File reads and writes use real Host services and existing GenOffice engines. The frontend does not use fixture arrays, hard-coded recents, fake delays, or `localStorage` as document persistence. Existing GenOffice recent-file, settings, and folder logic should be moved behind platform-neutral services while preserving compatible on-disk formats where practical.

## Tab model

Tabs become Host-owned product state rather than Electron `WebContentsView` state. The Host records order, active tab, title, editor kind, document identity, dirty state, and lifecycle. The Shell projects that state through `TabService` and sends activate, close, and reorder commands.

Closing a dirty tab is a structured workflow:

```text
close requested -> Host queries document state -> save/discard/cancel decision
                -> editor save or discard -> tab closed and state persisted
```

Browser refresh reconnects to the same Host tab model. It does not create duplicate documents. A packaged Electron restart may restore eligible tabs according to the existing GenOffice recovery policy.

Native popup menus are replaced with accessible shared-UI menus unless an operating-system menu is materially required. This removes the current assumption that sibling `WebContentsView` layers cover Shell DOM menus.

## Agent and editor data flow

The existing Sheets reference flow remains the standard:

```text
User prompt
  -> Shell AgentService
  -> Local Host
  -> supervised Harness runtime
  -> official Office Tool
  -> proposed semantic editor operation
  -> exact plan approval in shared Shell
  -> registered editor adapter
  -> apply / verify / commit or rollback
  -> Agent-facing result
```

The shared Shell owns approval presentation but not approval truth. The Local Host binds one-time authorization to the proposal hash, document, revision, session, and operation. Editor results remain bounded and serializable and do not expose ProseMirror, Univer, canvas, Electron, or Harness objects.

Each later editor preserves its existing GenOffice operation DSL, fills missing user-level editing capabilities into that DSL, and registers curated Harness tools against it. Engine methods are not converted mechanically into hundreds of Agent tools.

## Runtime modes

### Browser development

- A developer starts the Local Host with one or more authorized documents.
- The Host serves the shared Shell and editor bundles over an authenticated loopback origin.
- Chromium or the Codex built-in browser opens the one-time bootstrap URL.
- Browser DevTools and Node inspectors cover the complete product flow.

Opening source `index.html` through `file://` is unsupported and must show a clear development error if encountered rather than a blank screen.

### Electron desktop release

- Electron starts the bundled Local Host, Harness runtime, and required sidecars.
- It waits for Host readiness and opens the authenticated loopback URL in a `BrowserWindow`.
- It supplies the narrow desktop platform adapter.
- Closing the application performs an ordered shutdown of editor sessions, Host, Harness, and sidecars.
- The application bundles Node, pinned Harness assets, editor assets, and architecture-specific sidecars; it never depends on a user's Node installation.

### Future native desktop shell

A Swift/AppKit application embeds the shared frontend in `WKWebView`; a Windows application uses WebView2. The native shell starts or connects to the same Local Host and implements `PlatformService`. Replacing Electron does not change browser-visible service contracts or editor tools.

## Authentication and security

All modes preserve the Local Web security invariants already implemented by the Sheets slice:

- loopback-only random port;
- one-time bootstrap token exchanged for an HttpOnly same-site session;
- exact Host and Origin checks;
- authenticated HTTP and WebSocket requests;
- no wildcard CORS;
- validated and bounded messages;
- no arbitrary filesystem, shell, MCP, skill, or plugin exposure;
- official Office-only Harness Tool catalog;
- secret redaction and no credentials in browser storage;
- explicit, proposal-bound approval for mutations.

Packaged builds do not bypass these controls merely because the window is trusted. Electron navigation, new-window creation, permissions, and external URLs use deny-by-default policies.

## Settings and credentials

Non-secret settings are Local Host state and are read and written through `SettingsService`. API keys are stored through an OS credential-store service. The frontend receives only presence and non-secret metadata.

Browser development may configure credentials only when a supported OS credential helper is available. Otherwise the UI accurately reports that credential changes require the packaged desktop build; it must not place secrets in `localStorage`, query strings, or plain JSON.

Harness retains its provider and model architecture. NexusDesk isolates its Harness home and official profile so user-wide Harness patches cannot expand the product Tool catalog.

## Error handling and recovery

Every host method returns or throws a product-owned error with a stable code, safe message, retryability, and optional affected document. The Shell provides explicit loading, empty, disconnected, stale, denied, uncertain, and failed states.

WebSocket reconnect restores subscriptions from Host state. Pending writes are never guessed. The operation journal and browser terminal-result journal continue to prevent duplicate edits across disconnects. An uncertain mutation blocks further Agent writes for the document until verification or recovery resolves it.

Editor load failures remain isolated to the editor frame; the Shell and other tabs stay usable. Fatal Host or runtime failures show recovery actions and preserve diagnostic logs without exposing secrets.

## Migration strategy

The work is intentionally decomposed into separate vertical slices.

### Milestone 1: shared Shell and Sheets

- Define the host contract and capability model.
- Extract the existing GenOffice Shell renderer into a browser-safe shared package.
- Replace direct `window.aiOffice*` calls with injected services.
- Implement real Local Host services for home, recents, tabs, settings, and document lifecycle.
- Replace the temporary `apps/web` interface with the shared Shell.
- Host the already working Sheets renderer and Harness Tool flow.
- Preserve the existing Electron Shell through a compatibility adapter.
- Verify browser refresh, open, edit, approved Agent mutation, save, close, and reopen end to end.

### Milestone 2: Docs

- Add the Docs Web bootstrap and document service.
- Register a Docs editor adapter and curated native Harness tools.
- Cover document load, manual edit, Agent edit, undo, save, recovery, and export.

### Milestone 3: Slides

- Add the Slides Web bootstrap and document service.
- Register a Slides editor adapter and curated native Harness tools.
- Cover slide load, element edit, Agent edit, undo, save, recovery, and export.

### Milestone 4: remaining editors

- Add PDF, Markdown, and HTML using the same contracts.
- Add only editor-specific capabilities that are backed by real services.

### Milestone 5: desktop distribution

- Bundle the Local Host, Node runtime, Harness profile, shared frontend, editor assets, and sidecars.
- Add Keychain, signing, notarization, updater, protocol activation, and clean shutdown gates.
- Produce macOS first, then Windows and Linux artifacts.

Real-time collaboration remains a later independent program. The first five milestones preserve `documentId`, `operationId`, `revision`, `clientId`, and author identity so collaboration can replace document authority without replacing the frontend or tools.

## Verification strategy

### Contract tests

- Every `OfficeHost` request and event has runtime schema validation.
- Web and Electron adapters pass the same conformance suite.
- Capability combinations never expose unsupported actions.
- Browser-visible payloads contain no paths or secrets beyond their declared authorization.

### Shared UI tests

- Existing Shell component behavior is retained for home, tabs, settings, themes, and localization.
- Loading, empty, unavailable, error, reconnecting, and recovered states are covered.
- Visual regression snapshots compare the shared Web Shell with the current GenOffice reference at supported viewport sizes.

### Host integration tests

- Recents, settings, tabs, and document mutations survive a frontend refresh.
- File actions use real temporary files and the production services.
- Repeated operations are idempotent and stale revisions are rejected.
- Restart and disconnect tests cover committed, rolled-back, and uncertain outcomes.

### Editor vertical-slice tests

Each editor must pass manual edit, Agent read, exact-plan approval, Agent mutation, verification, undo, save, reload, and disconnect-after-commit scenarios before the next editor defines new shared behavior.

### End-to-end gates

- Chromium exercises the authenticated shared Shell with a real workbook and real Local Host services.
- Electron smoke tests launch the packaged topology and perform the same core scenario.
- No production E2E may use a fake document registry, fake save success, hard-coded frontend documents, or an MCP bridge.

## Success criteria for Milestone 1

- The Web build displays the existing GenOffice home, file-card, tab, settings, and Sheets experiences with NexusDesk product configuration.
- There is no separate simplified NexusDesk product interface.
- Browser and Electron Shells consume the same shared UI components and host contract.
- Home, tabs, settings, document open/save, and Agent state come from real Host services and survive refresh where their product semantics require persistence.
- Sheets preserves the completed Harness native Tool, approval, recovery, and revision behavior.
- Direct `file://` launch no longer fails as an unexplained blank page.
- All contract, unit, integration, Chromium E2E, Electron smoke, typecheck, lint, and production-build gates pass.

## Deferred work

- Docs and Slides implementation are separate milestones after the shared Shell and Sheets contract is stable.
- PDF, Markdown, and HTML follow Docs and Slides.
- Credential UI is limited by actual OS credential-helper availability until desktop packaging.
- Signed/notarized distribution follows functional Electron packaging.
- Swift/AppKit and WinUI shells are optional later replacements for Electron.
- Accounts, cloud documents, collaboration, presence, comments synchronization, and permissions remain outside this design's implementation plans.
