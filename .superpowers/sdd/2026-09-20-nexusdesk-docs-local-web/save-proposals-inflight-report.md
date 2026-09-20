# Save proposals / in-flight replay: review fix round 1

Date: 2026-09-20

## Scope and outcomes

All seven requested findings have implementation and focused regression coverage.

1. Five browser bridges now keep terminal Promise entries only while work is in flight. Completion removes an entry only when the stored Promise still matches; disposal clears it. Proposal caches and result journals have a 128-entry bound. Persisted result records have a 64 KiB UTF-8 limit.
2. Markdown and HTML save approval snapshots include the complete serialized save body/envelope; Markdown also includes image source inputs. A content change with an unchanged contentVersion invalidates approval.
3. Every proposal command takes the router's early, non-reserving path. A completed tool-call retry reuses its original proposal, approval outcome and terminal result even after the first save advances revision/contentVersion. Tests execute the actual four runtime save tools through the real router, registry and operation store; only the supervisor/browser IPC boundaries are simulated.
4. Journal getItem/setItem/removeItem errors cannot interrupt editor execution. Bounded memory replay remains available when storage fails. An unreadable/corrupt index disables further persistent insertion rather than creating unindexed keys.
5. An approved Sheets save locks the document body (including portalled dialogs), vetoes Univer command dispatch, refuses already-running edit batches and blocks queued/new App apply operations. The lock is released before session installation or in finally. Held second-phase inputs are cloned before the first asynchronous write. After the first write, the transaction completes with those approved inputs instead of reporting stale content and keeping the obsolete session. A second-phase failure adopts the first written session.
6. Docs and Sheets denied approvals return the standard not-ok AgentToolResult with APPROVAL_DENIED instead of throwing.
7. Docs save snapshots explicitly include mutable save inputs and the body. Immutable parsed source data is represented by object identity, source hash and file identity, never recursively traversed. Snapshot traversal has depth/node/size budgets. A 64 MiB original-byte fixture is not read or expanded; its snapshot stays below 4 KiB.

## RED / GREEN evidence

- Storage/cache regressions: four initial Sheets failures reproduced throwing storage reads/removals, unbounded persistence and oversized records. All five bridge suites now pass storage faults, terminal replay/eviction and proposal eviction cases.
- Full Markdown content: the new unchanged-version/content-drift test initially failed; both Markdown and HTML guard suites now pass.
- Real runtime/router save retry: all four editors initially failed with operation payload collisions; all four retry tests now pass with exactly one proposal, approval prompt and write.
- Sheets two-phase transaction: both success and second-write-failure tests initially observed only one write. They now verify two calls, immutable held inputs, edit veto, correct session adoption and lock release.
- Approval denial: four new Docs/Sheets apply/save denial cases initially rejected; they now resolve to APPROVAL_DENIED envelopes.
- Docs source snapshot: both large-source exclusion and mutable-input budget cases initially failed; they now pass.

## Verification

Targeted Vitest runs were serial, using `--maxWorkers=1`. No full application suite or library build was run in this round.

| Workspace | Targeted files | Tests passed |
| --- | --- | ---: |
| Docs | browser-save-replay, docs-save-adapter | 13 |
| Sheets | browser-save-replay, sheets-adapter, save-recovery-mode, approved-save-lock | 35 |
| Slides | browser-save-replay | 8 |
| Markdown | browser-save-replay, save-adapter-guard, markdown-editor-adapter | 17 |
| HTML | browser-save-replay, save-adapter-guard, html-editor-adapter | 16 |
| Runtime host | docs-tools, sheets-tools, save-snapshot-tools | 15 |
| Local host | agent-router, save-tool-retry | 26 |
| Web client | editor-result-journal | 6 |
| **Total** | **19 targeted test files** | **136** |

The eight relevant workspace typechecks passed: Docs, Sheets, Slides, Markdown, HTML, runtime-host, web-client and local-host. The final post-edit recheck of Docs, Sheets and web-client also passed (exit 0); the initial Docs stage of that redundant check was slowed by competing unrelated workspace processes.

Changed implementation/test files pass ESLint. Including the touched large App files reports only the known pre-existing Markdown `App.tsx:228` unused `body` error and three existing Sheets Hook dependency warnings. These unrelated issues were not changed. `git diff --check` passes.

## Exact implementation and test file manifest

```text
apps/docs/src/renderer/agent/browser-agent-api.ts
apps/docs/src/renderer/agent/docs-save-adapter.ts
apps/docs/tests/browser-save-replay.test.ts
apps/docs/tests/docs-save-adapter.test.ts
apps/html/src/renderer/App.tsx
apps/html/src/renderer/agent/browser-agent-api.ts
apps/html/src/renderer/agent/html-editor-adapter.ts
apps/html/tests/browser-save-replay.test.ts
apps/html/tests/save-adapter-guard.test.ts
apps/local-host/src/agent-router.ts
apps/local-host/tests/save-tool-retry.test.ts
apps/markdown/src/renderer/App.tsx
apps/markdown/src/renderer/agent/browser-agent-api.ts
apps/markdown/src/renderer/agent/markdown-editor-adapter.ts
apps/markdown/tests/browser-save-replay.test.ts
apps/markdown/tests/save-adapter-guard.test.ts
apps/sheets/src/renderer/App.tsx
apps/sheets/src/renderer/agent/browser-agent-api.ts
apps/sheets/src/renderer/approved-save-lock.ts
apps/sheets/src/renderer/save-actions.ts
apps/sheets/tests/approved-save-lock.test.ts
apps/sheets/tests/browser-save-replay.test.ts
apps/sheets/tests/save-recovery-mode.test.ts
apps/slides/src/renderer/agent/browser-agent-api.ts
apps/slides/tests/browser-save-replay.test.ts
packages/nexusdesk-runtime-host/src/docs-tools.ts
packages/nexusdesk-runtime-host/src/sheets-tools.ts
packages/nexusdesk-runtime-host/tests/docs-tools.test.ts
packages/nexusdesk-runtime-host/tests/save-snapshot-tools.test.ts
packages/nexusdesk-runtime-host/tests/sheets-tools.test.ts
packages/nexusdesk-web-client/src/editor-result-journal.ts
packages/nexusdesk-web-client/src/index.ts
packages/nexusdesk-web-client/tests/editor-result-journal.test.ts
```

The commit additionally includes this report only. It excludes unrelated analysis/progress/brief documents, registry/working-copy changes and the original Docs editor adapter.

## Review fix round 2

This section supersedes round 1's cache-lifetime and large-request replay claims. The reviewer correctly identified missing total-byte/TTL bounds and a P1 retry failure: the old fingerprint contained the entire request, so a legal 70 KiB mutation could produce a receipt larger than the 64 KiB record cap and lose its terminal result.

### Changes

- All five bridges now use a SHA-256 digest of the canonical request identity. The stored fingerprint is always 64 hexadecimal characters; full operation arguments are not duplicated into receipts. Fingerprint/registration dispatch is ordered, preserving first-arrival operation ownership without serializing the editor's asynchronous execution.
- Journal receipts have an absolute 10-minute TTL, a 128-entry limit, a 64 KiB per-record limit, and a 512 KiB per-document persistent total budget including keys and index metadata. In-memory serialized receipts/key bytes also have a 512 KiB budget. Reads and reloads do not extend expiry. Timer cleanup removes expired memory and persistent records; reopening also prunes expired records. Storage failures retain the bounded memory fallback.
- Proposal caches now have a 2-minute absolute TTL and an 8 MiB serialized-data budget in addition to the 128-entry limit. Opaque editor adapter handles are excluded from serialization, but snapshot/operation data is included.
- The real router emits an authenticated editor:proposal-released event when an approval is rejected, cancelled, unavailable or timed out, and when its agent turn is cancelled. The five bridges immediately delete matching edit/save/history proposal entries. The TTL is a fallback when a release event cannot be delivered.
- Release/disposal does not overwrite an already-running mutation's eventual terminal outcome. A mutation completing after disposal can still persist its successful receipt for a reloaded bridge, without repopulating the disposed bridge's in-memory receipt cache. Persistent expiry cleanup remains active for those receipts.
- Existing Markdown/HTML bridge tests were changed from an arbitrary zero-delay timeout to waiting for actual editor:result messages, matching WebCrypto's asynchronous digest behavior.

These are bounded replay caches, not indefinite execution ledgers: count/byte eviction and absolute TTL still apply. The change removes request-size-dependent loss of otherwise eligible mutation receipts.

### TDD evidence

1. Shared-cache RED: 3 new failures demonstrated missing idle proposal expiry, missing receipt expiry/cleanup, and a 1,232,209-byte journal exceeding the requested 512 KiB cap.
2. Real HTML bridge RED: a successful 70 KiB mutation retried as APPROVAL_INVALID, and rejected/cancelled proposals were still executable (3 failures).
3. Real router RED: all 5 rejection/cancellation/unavailable/turn-cancel/timeout cases lacked a browser release event.
4. Additional in-flight-disposal regression tests initially showed a lost late receipt and a successful mutation incorrectly changed to APPROVAL_INVALID. Both were corrected before handoff.
5. GREEN coverage now includes 70 KiB and 255 KiB editor-shaped operation payloads on all five real bridges, identical terminal replay both before and after bridge recreation, and exactly one adapter apply. Each recorded fingerprint is verified as a 64-character digest. Direct cache assertions verify retained save snapshots are physically deleted immediately on rejection/cancellation.

### Final verification

All test runs were serial with --maxWorkers=1. The final gate completed with exit 0:

| Workspace | Targeted files | Passed |
| --- | --- | ---: |
| Docs | browser-save-replay, browser-agent-api, browser-host-api | 29 |
| Sheets | browser-save-replay, browser-host-api | 33 |
| Slides | browser-save-replay, browser-agent-api, browser-host-api | 22 |
| Markdown | browser-save-replay, browser-agent-api, browser-host-api | 23 |
| HTML | browser-save-replay, browser-agent-api, browser-host-api | 22 |
| Web client | editor-result-journal | 13 |
| Local host | agent-router, save-tool-retry | 31 |
| **Total** | **17 targeted test files** | **173** |

Final typechecks passed for web-client, Docs, Sheets, Slides, Markdown, HTML and local-host. ESLint passed for every round-2 changed TypeScript file; git diff --check passed. No full application test suite or library build was run.

### Exact round-2 commit manifest

~~~text
.superpowers/sdd/2026-09-20-nexusdesk-docs-local-web/save-proposals-inflight-report.md
apps/docs/src/renderer/agent/browser-agent-api.ts
apps/docs/tests/browser-save-replay.test.ts
apps/html/src/renderer/agent/browser-agent-api.ts
apps/html/tests/browser-agent-api.test.ts
apps/html/tests/browser-save-replay.test.ts
apps/local-host/src/agent-router.ts
apps/local-host/tests/save-tool-retry.test.ts
apps/markdown/src/renderer/agent/browser-agent-api.ts
apps/markdown/tests/browser-agent-api.test.ts
apps/markdown/tests/browser-save-replay.test.ts
apps/sheets/src/renderer/agent/browser-agent-api.ts
apps/sheets/tests/browser-save-replay.test.ts
apps/slides/src/renderer/agent/browser-agent-api.ts
apps/slides/tests/browser-save-replay.test.ts
packages/nexusdesk-web-client/src/editor-result-journal.ts
packages/nexusdesk-web-client/src/index.ts
packages/nexusdesk-web-client/tests/editor-result-journal.test.ts
~~~
