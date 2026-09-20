# Document Registry Hardening Implementation Report

Date: 2026-09-20

## Scope

This change hardens Local Host document ownership and distinguishes a renderer's in-memory lifetime from its WebSocket transport lifetime.

## Root causes

1. `DocumentRegistry.register()` originally accepted client-provided document metadata as authoritative and overwrote the current owner.
2. Registry metadata was initially copied only at Host startup, so durable driver revisions and live browser revisions could diverge after HTTP saves or reconnects.
3. A WebSocket `clientId` identifies one transport connection, not one loaded editor page. Without a stable page identity, the Host could not distinguish a same-page transport reconnect from a complete reload.

## Implemented contract

- The Host initializes authorized document/editor/revision metadata and rejects unknown documents, editor mismatches, stale registrations, and attached-owner takeovers.
- The current owner may confirm its current revision idempotently or advance exactly one revision. Rollbacks and revision jumps are rejected.
- Driver/Host metadata is trusted; browser registration metadata is not.
- Detached documents refresh from the current driver metadata before a new renderer registers.
- Attached documents retain their owner/editor and only accept forward revision movement from trusted Host metadata.
- Successful HTTP content writes and driver actions synchronize the registry from `driver.document`.
- `editor:detach` detaches only its document, while WebSocket close detaches all documents owned by that client. A late close from an old client cannot detach a newer owner.
- `editor:register` now carries a required non-empty `rendererInstanceId`.
- `registerEditor()` creates one random renderer ID per handle and reuses it across reconnects. A new handle, representing a full reload, gets a new ID.
- Detach and WebSocket close preserve the last renderer ID:
  - same renderer reconnect: preserve the live revision and allow pending editor requests to be reissued;
  - new renderer reload: adopt the current driver/Host revision.
- The renderer ID is a lifecycle discriminator, not an authorization credential. Registration still requires a detached old owner and matching document/editor/revision metadata.

## TDD evidence

RED was observed before implementation at all three boundaries:

- Protocol rejected `rendererInstanceId` as an unknown field.
- Web client registrations had no stable per-handle identity.
- Local Host reset a same-renderer revision 2 reconnect to driver revision 1, preventing the reserved editor request from being reissued.
- A new renderer reload and the durable-driver fallback were covered independently.

GREEN verification:

- `npm run test -w @nexusdesk/protocol -- --maxWorkers=1`: 10/10 tests passed.
- `npm run test -w @nexusdesk/web-client -- --maxWorkers=1`: 6/6 tests passed.
- `npm exec -w @nexusdesk/local-host -- vitest run tests/document-registry.test.ts tests/ws-session.test.ts tests/agent-router.test.ts tests/server.test.ts --maxWorkers=1`: 47/47 tests passed.
- Type checking passed for `@nexusdesk/protocol`, `@nexusdesk/web-client`, and `@nexusdesk/local-host`.
- Targeted ESLint and `git diff --check` passed.

The complete repository suite is intentionally delegated to the controlling agent because concurrent suite execution had overloaded the shared host.
