# Critical 3 Task 1 report

Base: `a4e4ad57b27feda8deb7549dbfc0d986fb9a3cfe`.

Status: DONE_WITH_CONCERNS. Scope is the standalone `critical3-task-1-brief.md`; format app wiring remains Tasks 2–4. The concern is the unrelated, environment-dependent root-suite failure detailed below, plus the explicitly documented single-Host deployment boundary.

Baseline: Host Store / Router / registry suites: 71 tests passed.

Ruling: use the controller-provided worktree, brief and report as the execution ledger. Do not recreate its workspace, dispatch reviewers, or remove shared plan artifacts; the controller explicitly assigned this isolated subtask and prohibited child agents.

## RED / GREEN evidence

The following tests were first observed failing for the listed missing behavior, then passed after implementation. Existing fault/ownership assertions that passed on their first run are characterization coverage, not claimed RED evidence.

| Area | Observed RED | GREEN implementation |
| --- | --- | --- |
| Protocol | Durable registration fields rejected as unknown; partial identity accepted | Shared working-copy types and strict schemas; registration/lookup fields are all-or-none |
| Store | Source and operation-binding APIs absent | Immutable initial/current source snapshots, source index, terminal-bound authorization, load validation |
| Coordinator/upload | Constructors and APIs absent | Real Store-backed reservation, streamed parts, materialization, atomic terminal, restart lookup, bounded upload store |
| Receipt gate | Bare renderer success reached runtime and committed the in-memory operation | Runtime success now requires a verified durable terminal; HTTP commit is authoritative |
| Browser gate | Immediate registration before hydration; legacy ok journal replayed | Opt-in hydrate/register/Host-ack barrier and persistence-required bounded journal |
| HTTP | Bootstrap lacked workingCopy; unsafe content PUT returned 200 | Authenticated binary routes/source URLs and legacy write bypass rejection for opted-in drivers |
| Durable revision | Host head API absent | Registry-owned durable revision; volatile browser revision cannot advance it |
| Manual Save | Upload/manual helper/shared lane absent; browser raw ID became external operation ID | Explicit manual-save endpoint, Host-derived operation ID, internal preparation then promotion |
| Identity | Wrong editor type reserved; wrong-operation lookup receipt accepted | Driver/editor authorization and exact receipt operation/fingerprint/epoch validation |
| Runtime/fingerprint | Canonical fingerprint/runtime validation helper absent | Shared canonical identity and receipt-aware runtime validation |
| Recovery lifecycle | Live renderer rejected after own checkpoint; another bootstrap destroyed renderer proof | Separate immutable source issuance and confirmed live-renderer head records |
| Upload limits | Per-document cap absent; definitive failures consumed sealed upload slots | Per-document cap and ledger-first safe cleanup; unknown outcome retains evidence |
| Async delivery | HTTP notification and safe async runtime entry point absent | Durable commit notification, pending delivery retention and caught transport failure |
| Lookup wire | Durable WS lookup lacked top-level state/persistence | Top-level discriminated lookup result |
| Lost acknowledgement | Lost upload-create response yielded an untyped transport Error | Typed WORKING_COPY_OUTCOME_UNKNOWN without rerunning the mutation |
| Rebase/detach | Same-renderer source change accepted old upload; lane-bound detach absent | Generation rotates on source/epoch change; detach and ownership transitions use the document lane |

Two intermediate TypeScript failures were test-fixture type issues (branded IDs and LocalDocument/ShellDocumentSummary), corrected without changing product behavior. The fault test initially matched `/var` while macOS reported `/private/var`; using the real path made the intended fsync fault execute. These are not presented as product RED evidence.

## Implementation and self-review

- Extended the existing Store rather than replacing its save intent, durability, capacity or exact replay logic. Source snapshots and optional integration bindings are in the same manifest as checkpoints/save intents. Standalone legacy receipts remain readable, but cannot authorize a coordinator mutation without a binding.
- Added per-document coordination for hydration, owner generation, reservation, commit, preparation/promotion and detach. Stable operation identity includes document/epoch/editor/command/canonical arguments/approved plan, not request/client/current head. Historical replay precedes current target revision checks.
- Streamed temporary binary parts are hashed and bounded (128 MiB aggregate; JSON parts 256 KiB; 4 active uploads globally, 2 per document, 4,096 parts, 5-minute unsealed expiry). Commit checks the exact part set and hashes again. Unknown durable outcomes retain evidence; definitive absence permits reclaiming only that upload.
- Added authenticated HTTP source/checkpoint/lookup/manual-save endpoints. HTTP cookie identity must match the live socket client, and commit rechecks the active owner lease. Source reads are bound to the authenticated session/document/source issuance. General JSON and WS size limits are unchanged.
- Router consumes exact approval before reservation; only the already-approved PDF `modify_pdf_pages` branch can promote an apply. Renderer-only ok never becomes runtime success. HTTP commit and reconnect can supplement delivery without a second renderer mutation, even after the original operation owner disappears.
- Added browser binary persistence, exact lookup, shared mutation lane, hydration acknowledgement and receipt-aware bounded journal. Kept legacy mode compatible. Runtime validates optional persistence against the operation and current revision.
- Manual Save derives an external ID on the Host from the browser idempotency key. Agent/manual Save use the same Store boundary. New full snapshots get a deterministic internal preparation checkpoint; only promotion produces the external Save terminal. An unchanged dirty checkpoint promotes directly.
- Self-review covered all changed files and the brief's five review priorities: bare ok, stale owner/head and reconnect, source versus saved/working revision, all Save entry points, and structured async recovery. Regression tests exposed and fixed the same-renderer rebase/source-proof and detach issues. No independent reviewer/subagent was dispatched, per controller instruction.

## Verification

Latest specified focused gate (2026-09-20, 12:51 local) exited 0:

```sh
npm run test -w @nexusdesk/protocol -- tests/schemas.test.ts
npm run test -w @nexusdesk/local-host -- tests/working-copy-store.test.ts tests/working-copy-coordinator.test.ts tests/checkpoint-upload-store.test.ts tests/agent-router.test.ts tests/server.test.ts tests/document-registry.test.ts tests/ws-session.test.ts tests/operation-store.test.ts
npm run test -w @nexusdesk/web-client -- tests/working-copy.test.ts tests/client.test.ts tests/agent-api.test.ts
npm run test -w @nexusdesk/runtime-host
```

Results: protocol 9/9; Host 112/112 across 8 files (the brief's 7 files plus operation-store); web-client 14/14 across 3 files; runtime-host 61/61 across 11 files. Real Store bytes/ledgers, real HTTP+WS, and an actual fake-runtime child process are used. The binary HTTP test sends 2,000,001 bytes, over the unchanged generic JSON cap. Existing Store corruption, capacity, save-intent, rename, fsync and ENOSPC tests remain intact.

The following typechecks exited 0 after the final code change, and were repeated for final verification:

```sh
npm run typecheck -w @nexusdesk/protocol
npm run typecheck -w @nexusdesk/local-host
npm run typecheck -w @nexusdesk/web-client
npm run typecheck -w @nexusdesk/runtime-host
git diff --check
```

Additional latest root command:

```sh
npm test > .superpowers/sdd/2026-09-20-nexusdesk-docs-local-web/critical3-task-1-full-suite.log 2>&1
```

It exited 1 at the unchanged `@genoffice/electron-utils/tests/remote-image.test.ts`. Before that failure, the complete protocol 11/11, Host 180/180, runtime 61/61, web-client 27/27 and i18n 19/19 suites passed. electron-utils passed 180 tests and failed these 4:

1. `fetchRemoteImage > returns the response on first success`
2. `fetchRemoteImage > retries transient statuses until success`
3. `fetchRemoteImage > retries network errors and returns null when the budget is exhausted`
4. `fetchRemoteImage > does not retry permanent statuses like 404`

The tests mock fetch but leave the real DNS/SSRF precheck active. In this environment `node:dns/promises.lookup('sspark.genspark.ai', { all: true })` returned `28.0.0.81` and private IPv6 `fdfe:dcba:9876::51`; the guard rejects the private address before mocked fetch executes. `git diff a4e4ad57b27feda8deb7549dbfc0d986fb9a3cfe -- packages/electron-utils` is empty. No workaround or unrelated change was made. The root script uses `&&`, so packages after electron-utils were not executed. The full-suite log is ignored diagnostic output, not staged.

## Files and limitations

Task files (plus this report only) are staged explicitly:

```text
apps/local-host/src/agent-router.ts
apps/local-host/src/checkpoint-upload-store.ts
apps/local-host/src/document-driver.ts
apps/local-host/src/document-registry.ts
apps/local-host/src/operation-store.ts
apps/local-host/src/server.ts
apps/local-host/src/working-copy-coordinator.ts
apps/local-host/src/working-copy-store.ts
apps/local-host/src/ws-session.ts
apps/local-host/tests/checkpoint-upload-store.test.ts
apps/local-host/tests/document-registry.test.ts
apps/local-host/tests/operation-store.test.ts
apps/local-host/tests/server.test.ts
apps/local-host/tests/working-copy-coordinator.test.ts
apps/local-host/tests/working-copy-store.test.ts
packages/nexusdesk-protocol/src/frames.ts
packages/nexusdesk-protocol/src/index.ts
packages/nexusdesk-protocol/src/schemas.ts
packages/nexusdesk-protocol/src/working-copy.ts
packages/nexusdesk-protocol/tests/schemas.test.ts
packages/nexusdesk-runtime-host/src/index.ts
packages/nexusdesk-runtime-host/src/protocol.ts
packages/nexusdesk-runtime-host/tests/working-copy-protocol.test.ts
packages/nexusdesk-web-client/src/editor-registration.ts
packages/nexusdesk-web-client/src/editor-result-journal.ts
packages/nexusdesk-web-client/src/index.ts
packages/nexusdesk-web-client/src/working-copy.ts
packages/nexusdesk-web-client/tests/client.test.ts
packages/nexusdesk-web-client/tests/working-copy.test.ts
.superpowers/sdd/2026-09-20-nexusdesk-docs-local-web/critical3-task-1-report.md
```

Integration notes and remaining boundaries:

- Tasks 2–4 still own format serializers, factory instantiation and app/UI wiring. No format app/factory or `main.ts` was changed, and the gate activates only when a driver exposes `workingCopy`. The exported `WorkingCopyDriverOptions` accepts `workingCopyRoot`; `defaultWorkingCopyRoot()` resolves `nexusdeskAppDataDirectory()/working-copies`.
- Consumers must share the mutation lane between Agent apply/capture/Agent Save/manual Save; call `setHydrated` only after actual content restoration; include `registration.attached` in adapter attachment; preserve the live renderer's sourceContentId after a checkpoint; update its revisions and use `checkpointId = persistence.dirty ? persistence.checkpointId : null`. Complete reload/rebase acquires a new source and resets cumulative edits.
- The additive `/manual-save-uploads` endpoint exists because explicit UI Save has no Agent reservation. Its returned Host operationId, not the browser idempotency key, identifies durable lookup.
- Deployment is explicitly **one Host writer per recovery document**. There is no cross-process lock/CAS, so this does not claim linearizability across two Hosts writing the same file/root.
- Disk-backed uploads reduce transfer buffering, but materialization/Store still hold full bytes in memory. The byte and concurrency limits are not a low-memory guarantee.
- In-flight upload IDs are not durable across Host restarts; exact durable operation lookup is the recovery path. Completed-upload aliases are bounded to 4,096; old aliases may require lookup/new upload initialization. Source/history blobs are retained; no unsafe GC was introduced.
- Manual edits made after the captured checkpoint are not automatically crash-safe. Format-specific recovery error presentation, full editor hydration and end-to-end browser release proof belong to subsequent tasks.
- The pre-existing untracked `.superpowers/apply-refresh-recovery-analysis.md` is untouched and unstaged.
