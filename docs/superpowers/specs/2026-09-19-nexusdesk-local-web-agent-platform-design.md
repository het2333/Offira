# NexusDesk Local Web Agent Platform Design

## Status

Approved direction, pending written-spec review. This document defines the first product architecture and the extension boundaries required for additional editors and future real-time collaboration.

## Product intent

NexusDesk is a local-first Web application that opens in a normal browser, including the Codex built-in browser. A local host process serves the application, owns local files and credentials, and runs DeepSeek Harness as the agent engine. The first release supports the GenOffice document, spreadsheet, and presentation editors. Later releases can add other file editors without modifying the Harness integration.

The first release is single-user and local-only. Its protocols retain document, revision, author, and operation identities so a later Internet collaboration service can replace the local document authority without replacing editor adapters or agent tools.

## Confirmed requirements

- The application runs as a local Web service and opens in a browser.
- Users do not install Node.js, Docker, DeepSeek Harness, or separate profiles.
- DeepSeek Harness retains its multi-provider model support.
- Users configure providers in NexusDesk. API keys are stored through the operating-system credential store and are never returned to the browser.
- NexusDesk loads only its bundled, official editor tools. It does not expose MCP, user-installed skills, or user-installed plugins in the first release.
- Documents, spreadsheets, and presentations are supported in the first release.
- All user-relevant editing capabilities may be exposed as tools, but internal engine methods and objects are not exposed directly.
- Tool results are written for an agent. They do not return ProseMirror nodes, Univer instances, Electron objects, renderer objects, or other engine-owned values.
- The architecture supports later editor adapters and future remote collaboration.

## Non-goals for the first release

- Multi-user collaboration, accounts, teams, or Internet document hosting.
- Remote access to the local host.
- Arbitrary shell, filesystem, MCP, plugin, or skill installation.
- A one-to-one tool wrapper for every editor implementation method.
- Safari parity. The supported clients are current Chromium browsers and the Codex built-in browser.
- Replacing the editor engines already used by GenOffice.

## System architecture

The system contains four independently testable layers:

1. **Web Shell**: navigation, editor tabs, the agent panel, settings, approvals, and activity history.
2. **Local Host**: HTTP and WebSocket service, document authority, credential access, Harness lifecycle, session routing, persistence, and recovery.
3. **Agent Runtime**: a pinned DeepSeek Harness distribution running in a dedicated Node child process with the NexusDesk profile.
4. **Editor Adapters**: browser-side implementations that translate stable NexusDesk editor operations to the existing GenOffice editor engines.

```text
Browser / Codex built-in browser
              |
       HTTP + WebSocket
              |
NexusDesk Local Host
  |-- Web application server
  |-- Document hub
  |-- Credential service
  |-- Session store
  |-- Harness supervisor
  `-- Office tool router
              |
     versioned editor protocol
              |
Editor Adapter Registry
  |-- Docs adapter
  |-- Sheets adapter
  |-- Slides adapter
  `-- future adapters
```

The Local Host listens only on a loopback address. It chooses an available port, creates a high-entropy launch token, and opens the browser with a bootstrap URL. The bootstrap exchange replaces the URL token with an HttpOnly, same-site session cookie and immediately removes the token from browser history.

## Repository and dependency ownership

NexusDesk becomes the product repository. GenOffice supplies the editor engines and Web UI foundation. DeepSeek Harness is consumed as an exact, pinned dependency, not referenced through a sibling source checkout at runtime.

NexusDesk owns the following packages:

- `agent-protocol`: browser/host and host/Harness frame types.
- `document-protocol`: document identity, revision, transaction, presence, and lifecycle types.
- `editor-adapter`: the editor capability and operation interfaces.
- `office-tool-schema`: agent-visible tool inputs and results.
- `local-host`: HTTP, WebSocket, document routing, credentials, and process supervision.
- `runtime-host`: the adapter around the pinned Harness APIs.
- `office-tools`: Harness tools implemented against the NexusDesk protocols.

No Web package imports DeepSeek Harness directly. No adapter imports Harness types. No Harness package imports an editor engine.

## Protocol identity and versioning

Every request crossing a process or WebSocket boundary includes a protocol version. A write request also includes:

- `sessionId`: the owning agent session.
- `documentId`: a stable NexusDesk document identity.
- `editorType`: the registered adapter kind.
- `revision`: the document version on which the plan was prepared.
- `operationId`: a globally unique idempotency key.
- `clientId`: the browser connection that owns the editor instance.

The Local Host rejects unsupported protocol versions, missing identities, stale revisions, duplicate operations with mismatched payloads, and operations targeting a disconnected or different editor instance.

Successful operation results are cached by `operationId`. Retrying the identical request returns the recorded result without applying the edit again.

## Document authority

The Local Host owns document identity, lifecycle, persistence metadata, and revision allocation. The browser adapter owns the live engine instance for an open document. Neither side may infer the target from the currently focused tab.

For each open document, the host records:

- canonical document ID and editor type;
- source path or imported-document identity;
- current committed revision;
- attached browser client;
- save state and last durable version;
- active transactions and recent idempotency records.

The browser reports lifecycle transitions explicitly: opened, hydrated, changed, saved, detached, and closed. A browser disconnect suspends agent writes for its documents. It does not silently reassign them to another tab.

## Editor adapter contract

Each editor adapter advertises capabilities and implements stable semantic operations. The contract includes:

```ts
interface EditorAdapter {
  readonly editorType: string
  capabilities(): EditorCapabilities
  snapshot(documentId: string): Promise<AgentDocumentSummary>
  read(request: ReadRequest): Promise<AgentReadResult>
  propose(request: EditRequest): Promise<EditPlan>
  apply(plan: ApprovedEditPlan): Promise<AgentEditResult>
  verify(documentId: string): Promise<VerificationResult>
  undo(transactionId: string): Promise<AgentEditResult>
  save(documentId: string): Promise<AgentSaveResult>
  export(request: ExportRequest): Promise<AgentExportResult>
}
```

Adapters may use ProseMirror, Univer, canvas state, native sidecars, or other existing engines internally. Those values do not cross the adapter boundary. Each adapter maps its engine failures to the shared error vocabulary.

The first adapters preserve GenOffice's existing editing scope and behavior. The integration does not grant broader file access than the corresponding GenOffice editor already provides.

## Tool design

Tools describe user-meaningful actions rather than implementation methods. Common tool families cover document summary, scoped reads, search, selection, save, export, verification, and undo. Editor-specific tools use domain operations:

- Docs: text, paragraphs, headings, styles, lists, tables, images, links, and comments.
- Sheets: ranges, values, formulas, formatting, worksheets, charts, filtering, sorting, and validation.
- Slides: slides, elements, text, images, shapes, layout, themes, charts, animation, and notes.

Large reads are scoped and paginated. Binary data and screenshots travel as bounded references rather than inline payloads. Tools return agent-oriented results with this shared envelope:

```ts
interface AgentToolResult {
  ok: boolean
  summary: string
  changes?: { targets: string[]; count: number }
  warnings: AgentWarning[]
  verification?: { passed: boolean; issues: AgentIssue[] }
  continuation?: { suggestedTool?: string; reason?: string }
  transactionId?: string
}
```

Engine objects, raw document trees, unbounded cell matrices, and internal exceptions are forbidden in tool results.

## Write lifecycle

Every mutation follows one state machine:

```text
received -> validated -> proposed -> approved -> executing
                                            |-> committed -> verified
                                            `-> failed -> rolled-back
```

1. The host validates the tool input and document identity.
2. The adapter creates an `EditPlan` without mutating the document.
3. The Web Shell presents the target, summarized operations, and relevant warnings.
4. User approval authorizes that exact plan and revision once.
5. The adapter checks the revision again and applies the plan as one editor transaction.
6. The adapter verifies the affected structure.
7. Verification failure rolls the transaction back when the engine supports rollback. Otherwise the adapter restores the pre-transaction snapshot and reports recovery status.
8. The host records the final result under the operation ID and sends the agent-oriented result to Harness.

Cancellation before execution produces no mutation. Cancellation during execution waits for the editor transaction to reach committed or rolled-back state; the host never reports a guessed outcome.

## Harness integration

Harness runs in a dedicated, supervised Node process. The released application bundles a compatible Node runtime because the Electron runtime and a user's system Node are not accepted dependencies.

The NexusDesk Harness profile contains only the services required for model providers, agent/session operation, approvals, persistence, and the official NexusDesk tools. The Local Host provides model selection and credentials for each session. Provider secrets are passed through a private process channel or a tightly scoped child environment and are redacted from logs and durable events.

The runtime adapter maps Harness events to the stable NexusDesk event vocabulary. Web clients never consume undocumented Harness event objects directly. A Harness upgrade therefore changes the runtime adapter and compatibility tests, not every editor or UI component.

## Provider and credential management

The Web settings UI uses the existing GenOffice provider catalog where compatible. It may submit, replace, remove, and test a credential, but it can only read whether a credential exists and its non-secret metadata.

The Local Host stores secrets in macOS Keychain for the first release. Plain JSON settings store provider IDs, model IDs, base URLs, and capability metadata only. Logs, sessions, tool results, crash reports, and browser storage must not contain credentials.

The host maintains a provider capability table. Models that cannot perform reliable structured tool calls remain available for non-editing chat but cannot enter agent editing mode.

## Local Web security

The first release enforces these invariants:

- listen only on `127.0.0.1` or `::1`;
- reject unrecognized `Host` and `Origin` headers;
- never enable wildcard CORS;
- authenticate HTTP and WebSocket sessions;
- rotate the bootstrap token on each host launch;
- require explicit approval for mutation tools;
- validate every message at the transport boundary;
- cap payload, attachment, read, and event sizes;
- redact secrets before logging;
- prevent path traversal and enforce GenOffice's existing allowed roots;
- stop or suspend writes when the owning browser disconnects.

The service is not reachable from the LAN in the first release.

## Persistence and recovery

The Local Host persists session metadata, document metadata, operation outcomes, and Harness session references in its application data directory. It does not silently persist unsaved document content outside the editor's existing recovery policy.

After a crash, the host classifies an interrupted mutation as committed, rolled back, or uncertain using the recorded operation and editor recovery data. An uncertain mutation blocks further agent writes until the user opens and verifies the document. The host never automatically replays an interrupted mutation.

## Extension model

A future editor contributes:

- an editor type and capability manifest;
- a Web route and editor UI;
- an `EditorAdapter` implementation;
- semantic operation schemas;
- agent-oriented rendering for reads and results;
- validators and recovery behavior;
- adapter, integration, and end-to-end tests.

It does not change Harness supervision, credential management, the write state machine, or common approval UI.

## Collaboration compatibility

The first release does not implement collaboration. It nevertheless records author, client, document, revision, operation, and transaction identities. Agent edits use a dedicated agent author identity.

The later collaboration layer may use Yjs, Automerge, or another engine behind the Document Hub. Editor tools continue to submit semantic operations. The Document Hub translates them into collaboration transactions and performs authorization. Harness never generates raw CRDT updates.

Presence, cursors, comments, permissions, accounts, and team spaces remain separate future capabilities. Their absence must not add placeholder user interfaces to the first release.

## Delivery sequence

1. Normalize the NexusDesk repository and pin upstream dependencies.
2. Implement and test the shared protocols and error vocabulary.
3. Build the authenticated Local Host and WebSocket lifecycle.
4. Adapt and supervise the Harness runtime behind the stable agent protocol.
5. Build the unified Web Shell and document lifecycle.
6. Implement Sheets as the reference adapter and pass the complete safety lifecycle.
7. Implement Docs against the proven adapter contract.
8. Implement Slides against the proven adapter contract.
9. Add provider settings and Keychain-backed credential storage.
10. Package the macOS launcher, bundled Node runtime, Web assets, and Harness profile.
11. Complete security, recovery, performance, license, signing, and notarization gates.

Sheets is deliberately first because the existing prototype proves the Harness-to-editor flow. Docs and Slides begin only after the Sheets contract and safety tests pass. This prevents three divergent adapters from defining the protocol simultaneously.

## Verification strategy

Each adapter has four test layers:

1. schema and operation unit tests;
2. adapter-to-engine integration tests;
3. keyless recorded Harness session replays;
4. browser end-to-end tests through the Local Host.

Release-blocking scenarios include:

- an identical operation cannot execute twice;
- a stale revision cannot mutate a document;
- a rejected or expired approval cannot mutate a document;
- a failed mutation restores the prior state;
- post-write verification rejects structurally invalid output;
- a disconnected or wrong client cannot receive a document mutation;
- refresh and reconnect preserve the transcript without replaying tools;
- Harness crashes do not corrupt open documents;
- credentials never appear in logs, storage snapshots, protocol frames, or tool results;
- packaged builds start without system Node, environment variables, or sibling repositories;
- the Docs, Sheets, and Slides end-to-end fixtures reopen successfully in an independent reader.

## Principal risks and controls

- **Pre-stable Harness APIs:** pin one exact release and isolate it behind `runtime-host`.
- **Document corruption:** require proposal, approval, transactional execution, verification, and recovery.
- **Localhost attacks:** use loopback binding, bootstrap authentication, origin checks, and no wildcard CORS.
- **Wrong-tab edits:** route by document, revision, and client identity, never by focus.
- **Context growth:** use scoped reads, pagination, summaries, and bounded references.
- **Provider inconsistency:** gate editing by provider capabilities and validate every tool call.
- **Scope growth:** ship three adapters and single-user local operation before implementing new editors or collaboration.
- **Upstream drift:** keep product-owned adapters and pin both upstream revisions for each release.

## Acceptance criteria

The first release is complete when a user can install NexusDesk on macOS, launch it without external runtimes or configuration, open it in a supported browser, configure any supported provider with Keychain-backed credentials, open and safely edit document, spreadsheet, and presentation files through Harness tools, approve and undo mutations, recover from browser or Harness failure without duplicate writes, and reopen the saved artifacts successfully in independent Office-compatible readers.
