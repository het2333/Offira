# NexusDesk Office Host contract

`OfficeHost` is the stable boundary between the shared Shell UI and the product
environment. Its types and Zod wire schemas live in
`packages/nexusdesk-office-host`. The Shell consumes this interface instead of
reading Electron preload globals, Node APIs, filesystem paths, or Local Host
HTTP responses directly.

## Ownership

The host owns these semantic services:

- `bootstrap()` returns capabilities, authorized document summaries, the tab
  model, and persisted Shell settings as one consistent snapshot.
- `files` lists opaque authorized `fileId` values, opens a file, and toggles its
  starred state. A `fileId` is not a browser-supplied filesystem path.
- `documents` lists, saves, and closes documents through stable `documentId`
  values.
- `tabs` activates, closes, reorders, and publishes authoritative tab state.
- `settings` reads, updates, and publishes language, theme, and onboarding
  state.
- `agent` is the semantic Shell-level Agent surface. In the Sheets milestone,
  active editor sessions own Agent turns, so unsupported Shell calls fail with
  `UNSUPPORTED_CAPABILITY` instead of reporting fake success.
- `platform` contains negotiated native actions such as file browsing, Finder
  reveal, and trash. The Shell renders an action only when the corresponding
  capability is true.

All HTTP success payloads, error payloads, WebSocket Shell events, and startup
snapshots are schema-validated. Expected failures use `HostError` with a stable
code, retryability, and optional document identity.

## Web and Electron adapters

`apps/web/src/web-office-host.ts` maps the contract to authenticated same-origin
HTTP and WebSocket calls. Local Host is authoritative: a mutation returns a
fresh snapshot, and a `shell:changed` event triggers a bootstrap refresh so
multiple browser clients converge on persisted state. The browser adapter does
not accept arbitrary local paths and advertises no capability that lacks a real
service.

`apps/shell/src/renderer/src/electron-office-host.ts` maps the same contract to
the existing GenOffice preload APIs. Electron-only compatibility services are
injected separately as `ShellPlatformServices`; they are not imported by shared
components. This keeps the UI reusable by a later Swift/AppKit or WinUI shell.

## Editor isolation

Each editor remains its own bundle and engine. The shared Shell mounts only the
active browser editor in an iframe under a canonical route such as:

```text
/sheets/?host=local-web&documentId=<opaque-document-id>
```

Local Host serves Shell assets at `/` and Sheets assets at `/sheets/`. SPA
fallback for one bundle must never serve the other bundle's index. Electron may
host the same editor UI with native views, but the Shell contract and editor
identity remain unchanged.

## Product capability rules

NexusDesk product configuration currently enables Sheets and hides upstream
GenOffice account, cloud-project, integration, and MCP surfaces. MCP is legacy
GenOffice compatibility, not a NexusDesk bridge. New browser actions require a
semantic `OfficeHost` service and real Local Host persistence before the UI may
advertise them; do not call Electron-only methods or fabricate successful
responses.

Tool execution crosses a separate editor-adapter boundary. See
[Editor adapter contract](editor-adapter.md): Harness keeps its multi-provider
runtime, editor DSLs become native Tools, and every result is an Agent-facing
envelope rather than a raw engine object.
