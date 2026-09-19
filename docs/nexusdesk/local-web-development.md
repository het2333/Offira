# NexusDesk local Web development

NexusDesk's local Web application runs a loopback-only Node host, the shared
GenOffice Shell, isolated GenOffice Docs and Sheets renderers, and a supervised
DeepSeek Harness runtime. The browser never talks to Harness directly. Local
Host owns documents, tabs, settings, sessions, approvals, operation journals,
and the runtime process.

The current product scope is the local Web application. The shared React
components do not import Node or Electron, so editor code remains portable, but
desktop packaging is not part of this milestone. Docs and Sheets are proven in
Chromium; Slides, PDF, Markdown, HTML, browser file picking, Safari, OS-backed
credential storage, and collaboration follow their own Web milestones.

## Prerequisites

- Node.js 22.12 or newer and npm 10 or newer.
- Rust and Cargo on `PATH` for the Sheets XLSX sidecar.
- A Chromium browser for the acceptance test.

Install dependencies once from the repository root:

```bash
npm install
```

## Build and start the local application

The Local Host currently serves built assets; the Vite development ports are
not proxy targets. Rebuild after changing the Web shell or either renderer:

```bash
npm run build:web
npm run start:web -- /absolute/path/to/Report.docx /absolute/path/to/Forecast.xlsx
```

Startup writes exactly one JSON line containing a one-time bootstrap URL:

```json
{ "bootstrapUrl": "http://127.0.0.1:49152/bootstrap?token=..." }
```

Copy the complete URL, including the token, into the Codex built-in browser.
The first request exchanges the token for an `HttpOnly; SameSite=Strict`
session cookie and redirects to `/`; the same token cannot be replayed. Do not
paste the bootstrap URL into logs, issues, or screenshots.

Do not open `apps/web/index.html` directly. A `file://` launch is a diagnostic
page only: it cannot exchange the one-time token, receive the secure cookie, or
reach authenticated HTTP/WebSocket services. Always use the URL printed by
`npm run start:web`.

The production entry resolves the bundled Harness runtime and profile from the
repository. Environment variables cannot replace the runtime entry path. Model
provider configuration and credentials remain owned by DeepSeek Harness, not
the editor iframe.

The production startup accepts one or more explicit `.docx` and `.xlsx` paths.
Each path is resolved and authorized before the Host starts; the browser cannot
choose an arbitrary filesystem path. The shared Home shows those authorized
documents and keeps each opened editor iframe mounted while switching tabs. A
browser file picker is not wired into this milestone yet.

## Supported Docs Web behavior

Web Docs reuses the GenOffice renderer and DOCX engine. It supports the normal
document canvas and ribbon, manual text/format edits, the existing Docs
operation DSL, in-place save to the startup-authorized file, tab switching,
and refresh recovery from the saved bytes. `read_document`,
`apply_document_operations`, and `save_document` are registered directly as
Harness tools. MCP is not part of the NexusDesk request path.

The Local Host serves DOCX bytes through an authenticated content endpoint.
Every write carries the revision that the editor opened. A successful atomic
replace advances the Host revision; a stale writer receives
`REVISION_CONFLICT` and cannot overwrite newer bytes. Edit proposals bind the
operation batch, revision, client, and document to an exact SHA-256 plan hash.
One-time approval is consumed only for the first execution, while a retry of
the same `operationId` receives the recorded Agent-facing result without
executing the edit again.

The Web capability contract deliberately reports these native-only features as
unavailable: arbitrary file open, Save As, DOCX encryption, native printing,
Zotero, external attachment paths, OS provider settings, and native export
dialogs. The UI must hide or disable those actions instead of reporting fake
success. The authorized in-place save remains available.

Stop the process with `Ctrl-C`. The host closes browser sockets, disposes the
router, and shuts down the Harness child.

## Debug Local Host and Harness

Build first, then start Node with inspector endpoints bound only to loopback:

```bash
npm run build:web
NODE_OPTIONS='--inspect=127.0.0.1:0' npm run start:web -- /absolute/path/to/Forecast.xlsx
```

The Local Host prints its `Debugger listening on ws://127.0.0.1:...` line. The
supervisor captures the Harness child's stderr, so locate both allocated ports
and their process IDs on macOS with:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep node
ps -o pid=,command= -p <pid>
```

Open `chrome://inspect`, choose **Configure**, add the discovered loopback
ports, and attach to the process whose script name is:

- `apps/local-host/lib/main.mjs` for HTTP, WebSocket, routing, and ownership.
- `packages/nexusdesk-runtime-host/lib/index.mjs` for Harness events and native
  Tool dispatch.

Using port `0` lets the operating system allocate distinct inspector ports to
the parent and child. Do not bind an inspector to a non-loopback address. If
`grep` is unavailable, filter the `lsof` output manually.

For browser-side debugging, open DevTools for the bootstrap page. Docs and
Sheets run in iframes, so select the `/docs/` or `/sheets/` frame before setting
renderer breakpoints. In the Network panel, select the `/ws` request and inspect its
**Messages** tab. Useful frame sequences are:

```text
server:ready -> editor:register -> agent:start
approval:request -> approval:response
editor:request -> editor:revision -> editor:result
```

An `editor:revision` may legitimately arrive before the result for the mutation
that produced that revision. A policy close with code `1008` means the browser
sent an invalid or ownership-mismatched frame; an oversized frame closes with
`1009`. Authentication failures reject the HTTP upgrade before a WebSocket is
established.

## Run the keyless acceptance test

The acceptance suite uses deterministic runtime protocol fixtures; it needs no
provider account or model credential. The Sheets flow creates a real XLSX
through the Rust gateway, approves and applies a formula-and-chart operation,
saves, reloads, retries the same operation ID, and independently reopens the
result through the GenOffice CLI. The Docs flow copies a real DOCX, performs a
manual edit plus an approved native Docs operation, saves, reloads, retries the
same operation ID, and checks the persisted OOXML text and one-time execution
count.

```bash
npm run test:e2e:local-web
```

`test:e2e:local-web` rebuilds all served Web assets before launching Chromium,
so stale bundles cannot mask or invent failures. Assistant text is observed
only to prove streaming; document/workbook bytes and execution counts are the
correctness oracles.

Focused milestone checks:

```bash
npm test -w @nexusdesk/protocol
npm test -w @nexusdesk/local-host
npm test -w @nexusdesk/web-client
npm test -w @genoffice/docs -- docs-command-executor docs-editor-adapter browser-agent-api
npm test -w @genoffice/sheets -- sheets-command sheets-adapter browser-host-api mcp-bridge-ops
npm run test:e2e:local-web
npm run typecheck
```

The generated `playwright-report/` and `test-results/` directories are local
test artifacts and must not be committed.

## Component map

| Component                         | Responsibility                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/local-host`                 | Loopback HTTP/WebSocket authority, bootstrap authentication, document ownership, operation journal, Harness supervision |
| `apps/web`                        | Browser composition root, `OfficeHost` HTTP/WebSocket adapter, and shared Shell mount                                   |
| `packages/nexusdesk-shell-ui`     | Host-neutral GenOffice Home, tabs, settings, product capability gates, and editor frame routing                         |
| `packages/nexusdesk-office-host`  | Runtime-validated Shell contract for files, documents, tabs, settings, capabilities, and Agent-facing errors            |
| `packages/nexusdesk-runtime-host` | DeepSeek Harness profile, multi-provider agent sessions, native Docs/Sheets Tools, stable IPC projection                |
| `packages/nexusdesk-protocol`     | Versioned JSON frames, branded identities, editor and Agent result contracts                                            |
| `packages/nexusdesk-web-client`   | Browser WebSocket lifecycle, reconnect behavior, editor registration, Agent API                                         |
| `apps/docs`                       | GenOffice Docs UI, DOCX engine integration, Docs DSL adapter, revisioned in-place save                                  |
| `apps/sheets`                     | GenOffice Sheets UI, XLSX engine integration, Sheets DSL adapter, apply/verify/save behavior                            |

See [Office Host contract](office-host-contract.md) for Shell/platform ownership
and [Editor adapter contract](editor-adapter.md) before adding another editor.
