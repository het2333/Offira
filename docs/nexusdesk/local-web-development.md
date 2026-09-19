# NexusDesk local Web development

NexusDesk's first Web milestone runs a loopback-only Node host, an authenticated
Web shell, the GenOffice Sheets renderer, and a supervised DeepSeek Harness
runtime. The browser never talks to Harness directly. The Local Host owns the
session, document identity, approvals, operation journal, and runtime process.

This milestone proves Sheets in Chromium. Docs, Slides, file picking, packaged
startup, Safari, Keychain integration, and collaboration are follow-on work.

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
not proxy targets. Rebuild after changing the Web shell or Sheets renderer:

```bash
npm run build:web
npm run start:web -- /absolute/path/to/Forecast.xlsx
```

Startup writes exactly one JSON line containing a one-time bootstrap URL:

```json
{ "bootstrapUrl": "http://127.0.0.1:49152/bootstrap?token=..." }
```

Copy the complete URL, including the token, into the Codex built-in browser.
The first request exchanges the token for an `HttpOnly; SameSite=Strict`
session cookie and redirects to `/`; the same token cannot be replayed. Do not
paste the bootstrap URL into logs, issues, or screenshots.

The production entry resolves the bundled Harness runtime and profile from the
repository. Environment variables cannot replace the runtime entry path. Model
provider configuration and credentials remain owned by DeepSeek Harness, not
the editor iframe.

The production startup opens one explicit XLSX path and registers it as the
active Sheets document. A file picker and multi-document registry are not wired
into this milestone yet.

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

For browser-side debugging, open DevTools for the bootstrap page. The Sheets
editor runs in an iframe, so select the `/sheets/` frame before setting renderer
breakpoints. In the Network panel, select the `/ws` request and inspect its
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

The acceptance test uses a deterministic fake Harness runtime; it needs no
provider account or model credential. It creates a real XLSX through the Rust
gateway, opens the authenticated application in Chromium, approves and applies
a formula-and-chart operation, saves, reloads, retries the same operation ID,
and independently reopens the result through the GenOffice CLI.

```bash
npm run test:e2e:local-web
```

The test asserts workbook cells, the formula, and exactly one chart. Assistant
text is observed only to prove streaming; it is not the correctness oracle.

Focused milestone checks:

```bash
npm test -w @nexusdesk/protocol
npm test -w @nexusdesk/local-host
npm test -w @nexusdesk/web-client
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
| `apps/web`                        | Authenticated document shell and editor iframe host                                                                     |
| `packages/nexusdesk-runtime-host` | DeepSeek Harness profile, multi-provider agent sessions, native Sheets Tools, stable IPC projection                     |
| `packages/nexusdesk-protocol`     | Versioned JSON frames, branded identities, editor and Agent result contracts                                            |
| `packages/nexusdesk-web-client`   | Browser WebSocket lifecycle, reconnect behavior, editor registration, Agent API                                         |
| `apps/sheets`                     | GenOffice Sheets UI, XLSX engine integration, Sheets DSL adapter, apply/verify/save behavior                            |

See [Editor adapter contract](editor-adapter.md) before adding another editor.
