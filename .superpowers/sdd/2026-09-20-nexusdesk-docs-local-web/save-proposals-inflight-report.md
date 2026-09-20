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
