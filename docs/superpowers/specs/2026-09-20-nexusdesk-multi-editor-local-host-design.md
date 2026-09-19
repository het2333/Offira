# NexusDesk Multi-Editor Local Host Design

## Intent

NexusDesk will reuse the GenOffice Shell and editor renderers in both a local Web application and a packaged desktop application. Users must be able to open, edit, save, and use the Harness Agent in Docs, Sheets, Slides, PDF, Markdown, and HTML without an MCP product bridge. The packaged application and local Web server must share the same renderer code and product-owned Host contracts.

The previously completed Sheets milestone is the reference implementation. This design extends it without weakening its approval, operation replay, Host authority, or multi-provider Harness boundaries.

## Fixed product decisions

- The Local Host is authoritative for authorized files, open documents, tabs, settings, document routing, revisions, recovery, and Agent sessions.
- GenOffice renderer UI and editor engines remain the implementation of Office editing. NexusDesk supplies browser/native adapters; it does not fork the visual editors.
- Harness retains its provider/model selection architecture. Editors expose product-native tools through `@nexusdesk/protocol`; MCP remains a GenOffice compatibility surface and is not used by NexusDesk.
- Tool results are bounded Agent-facing envelopes. Engine objects, Electron objects, private Harness metadata, and model reasoning never cross the product protocol.
- Editing tools preserve each editor's existing operation DSL. The tool catalog groups stable capabilities instead of exposing hundreds of low-level engine methods.
- Electron is the first packaged shell. Shared renderers and Host contracts must remain free of Electron imports so a later Swift/AppKit or WinUI shell can host the same Web application.
- No frontend control may advertise success unless a real Local Host or editor operation completed. Native-only controls are hidden or return a typed unsupported result.

## Delivery decomposition

This architecture is delivered as independently testable milestones:

1. Docs local Web adapter and native Harness tools.
2. Slides local Web adapter and native Harness tools.
3. PDF, Markdown, and HTML local Web adapters and native Harness tools.
4. Electron packaging of the Local Host plus shared Web Shell.
5. Collaboration transport built on document revision and operation journals.

Each milestone must leave the current editors working and distributable on its own. A milestone is not allowed to replace production paths with mocks in order to unblock the next one.

## Shared architecture

### Document drivers

`apps/local-host` owns a registry of `LocalDocumentDriver` instances. A driver has one editor kind, one authorized document, and the following lifecycle:

```ts
interface LocalDocumentDriver {
  readonly document: LocalDocument
  bootstrap(origin: string): Promise<unknown>
  execute(action: string, payload: unknown): Promise<unknown>
  readContent?(): Promise<{ bytes: Uint8Array; contentType: string }>
  writeContent?(bytes: Uint8Array, expectedRevision: Revision): Promise<ShellDocumentSummary>
  close(): Promise<void>
}
```

The Host routes `/api/documents/:id/*` to the matching driver. Static editor routes use `/docs/`, `/sheets/`, `/slides/`, `/pdf/`, `/markdown/`, and `/html/`. The server rejects unknown document/action combinations instead of falling through to another editor.

### Renderer adapters

Each GenOffice renderer gets a browser entry adapter installed before React mounts. It exposes the existing preload-shaped API so the editor UI stays shared, while mapping supported methods to authenticated Host HTTP/WebSocket operations. Unsupported native integrations reject with editor-specific typed errors and are capability-gated out of the UI.

Large Office files do not travel inside JSON. Bootstrap returns metadata; content endpoints use `application/octet-stream`. Save requests include the Host-authoritative expected revision and produce a new document summary. The Host atomically replaces the authorized file only after the editor engine has produced valid bytes.

### Native Agent tools

The runtime receives the active editor kind and advertises only the stable tools for that editor. Tool definitions map to these product commands:

| Editor | Read | Propose/apply | Save/export |
| --- | --- | --- | --- |
| Docs | `read_document` | existing Docs operation DSL (`insert_content`, `replace_blocks`, `apply_ops`) | `save_document` |
| Sheets | `read_sheet` | existing workbook operation DSL | `save_sheet` |
| Slides | `read_presentation` | existing presentation transaction/edit-script DSL | `save_presentation` |
| PDF | `read_pdf` | existing annotation/text/image/redaction DSL | `save_pdf` |
| Markdown | `read_markdown` | structured text patch DSL | `save_markdown` |
| HTML | `read_html` | DOM-safe operation DSL | `save_html` |

Every mutation follows proposal -> exact one-time approval -> apply -> verify. The proposal contains a stable hash, human summary, and bounded targets. `operationId` replay is idempotent across reload/reconnect. The Agent sees `AgentToolResult`; it never receives editor engine instances or raw Electron IPC results.

### Save, close, and recovery

The active renderer owns the working copy. Home/tab transitions keep its frame mounted. Closing a dirty document must eventually use save/discard/cancel; until that protocol is implemented for an editor, closing hides but does not destroy its mounted working copy.

Browser saves go through the renderer adapter because only the renderer owns unsaved edits. `OfficeHost.documents.save()` remains unsupported until the working-copy protocol can ask an active renderer for bytes. Driver writes are atomic and revision-checked. Recovery copies are Host-owned and must survive page reload or process restart.

## Docs milestone

Docs loads the authorized `.docx` bytes from the Host through a browser `DesktopApi`. The existing `@genoffice/docx-engine` parsing and renderer state remain unchanged. `saveDocx` posts the generated bytes back to the same authorized document and advances the Host revision. Native file dialogs, password-encrypted input, printing, external attachment paths, and OS clipboard image integration remain capability-gated until their browser-safe contracts exist.

The existing Docs command DSL is extracted from its MCP transport wrapper into a transport-neutral executor. A NexusDesk Docs adapter supplies proposal summaries, exact approval binding, execution, verification, save, and replay. GenOffice MCP calls the same executor but remains a separate compatibility entry point.

## Slides milestone

Slides requires a headless presentation service because its current source of truth lives in the Electron main process. Pure session and transaction logic moves behind a `SlidesDocumentDriver`; Electron IPC and Local Host HTTP become two transports over that service. The existing `@genoffice/pptx-engine`, `@genoffice/pptx-ops`, and `@genoffice/pptx-render` remain authoritative. Dialog-only operations stay hidden in Web; operations with browser-provided bytes use explicit upload endpoints.

The Agent surface uses presentation transactions/edit scripts rather than one tool per IPC handler. The driver journals transactions for collaboration and operation replay.

## Remaining editors and desktop

PDF follows the Slides pattern for main-process state. Markdown and HTML follow the Docs pattern because their renderer owns text state and can exchange bounded text/bytes with the Host. After all routes pass the same conformance suite, Electron starts the Local Host as an owned child/service, opens its authenticated bootstrap URL in the shared Shell window, and shuts it down with the application. Signing, notarization, installers, and update feeds are release tasks on top of that topology.

## Collaboration readiness

Collaboration is not implemented by sharing renderer engine objects. Each driver emits document-scoped operations with sequence, base revision, author/client id, and deterministic payload. A later transport may distribute those operations; clients that cross a reset marker or unsupported operation perform a full snapshot resync. Presence and comments remain separate ephemeral/persistent channels.

## Security and failure behavior

- The Host binds loopback only, exchanges a one-time bootstrap token for an HttpOnly SameSite cookie, validates Origin/Host, and authenticates WebSocket upgrades.
- File ids authorize exact user-selected/startup paths; renderer-supplied paths cannot expand authority.
- Binary upload size is capped per editor and written to a private temporary file before atomic replacement.
- Revision conflicts return a typed non-retryable conflict result; transport loss is retryable and never converts an already committed operation into failure.
- Unknown frames, actions, tools, and editor kinds fail closed.
- Provider credentials stay in the Harness/provider layer and never enter editor tool results.

## Verification

Every editor milestone includes unit tests for adapter truthfulness, driver authorization/revision/save behavior, proposal approval binding, operation replay, disconnect recovery, and result projection. A real Chromium test opens the shared Home, activates the editor, performs one manual edit and one Agent-approved edit, saves, reloads, and proves the edit was applied exactly once. Desktop packaging additionally runs an Electron smoke test against the same Shell route.
