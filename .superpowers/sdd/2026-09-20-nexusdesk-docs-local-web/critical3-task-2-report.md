# Critical 3 Task 2 — Docs implementation report

Base: `1a8b6ed8e4f899d0d5c72c685bb1ae4866b4295e`.

## Delivered

- `createDocsDocumentDriver(path, { workingCopyRoot? })` now owns the existing WorkingCopyStore, exposes immutable source acquisition/reads, validates exactly one full `docx-bytes/document` part, and returns current checkpoint bytes and version-bound bootstrap metadata. Legacy content writes fail with the existing `UNSUPPORTED_CAPABILITY` code; they cannot invalidate the Store baseline.
- The Docs bridge awaits full DOCX capture and the public binary checkpoint helper before delivering apply success with a persistence reference. Concurrent duplicate requests share execution; replay checks the Host ledger using the epoch-bound fingerprint before consulting proposals. An old browser journal cannot establish durable success. Historical replay never replaces the newer renderer head.
- Capture reuses `buildDocBytes` and its complete serialization inputs. The existing bounded save snapshot/source identity logic is reused for before/after checks, including non-body settings. App flushes pending React state and table edits before capture. Agent operations, capture and manual Save share the browser mutation lane.
- Browser bootstrap loads `workingCopy.contentUrl` even when the legacy top-level URL differs, supplies `recovered:true` for dirty recovery, and waits for complete App hydration before registering. `attached` depends on the Host registration acknowledgement. The body remains read-only while unregistered.
- Agent exact-snapshot Save routes its serialized bytes through its approved checkpoint reservation; manual Save uses `saveManual`. Both use coordinator preparation/promotion. The existing file action rebases the editor from the saved complete bytes and clears dirty only if the complete state is unchanged. A completed save remains successful if subsequent editor rebase fails, with a specific saved/reload-failed status.
- A stale initial hydration receives bounded automatic recovery: up to three delayed bootstrap/source fetches, then normal App hydration and registration. An already registered session, or a sidebar edit made while initial registration was pending, retains its local content and displays the recovery error. Large documents that exceed approval-snapshot limits can still hydrate; automatic replacement is declined when a safe comparison is unavailable.
- Web timer/blur autosave cannot write the original; its UI toggle is disabled. Explicit manual Save and approved Agent Save remain enabled. Electron paths retain their prior behavior.

## RED → GREEN evidence

1. Driver tests initially failed because `workingCopy` was undefined, bootstrap used `/content`, and concurrent legacy writes replaced the original. After integration all six driver cases passed.
2. The initial capture module import failed at test discovery; this was corrected to a missing-entry-point assertion so all three intended tests ran and failed on the absent capture API before implementation. Full capture and non-body race tests then passed; the bridge test next failed on the absent `setHydrated`, and passed after its receipt/hydration integration.
3. Browser Host hydration initially registered immediately (`1` registration vs expected `0`) and manual Save used legacy transport (`1` write vs expected `0`). Both passed after the source/hydration/persistence wiring.
4. Manual Save complete-state guard initially never entered the capture boundary; after routing through complete capture, a header mutation during serialization rejected the save with zero writes and dirty preserved.
5. Saved-but-rebase-failed initially returned `false`; it now returns success for the already completed write and reports reload failure while preserving dirty.
6. Stale bootstrap recovery initially emitted no fresh open event. After recovery wiring it fetches the newer version-bound source, emits the complete dirty open result, and sends no new registration until the consumer marks hydration complete.
7. A manual header edit before the first registration acknowledgement initially caused two reload HTTP requests. The full-state guard now issues none and preserves the edit and dirty state.
8. A document larger than the bounded approval snapshot initially threw during `setHydrated`. Hydration now succeeds while automatic destructive replacement remains disabled when its snapshot cannot be compared.
9. A timer-style Web save initially returned `{ok:true}` and wrote the original. It now fails before any HTTP upload; the same payload under explicit manual Save or an approved Agent Save still succeeds.
10. Local Host typecheck exposed the nonexistent `WORKING_COPY_REQUIRED` HostErrorCode; the driver now uses `UNSUPPORTED_CAPABILITY`, and Host typecheck passed.

Durable-journal, empty-storage historical replay, Agent Save reservation, and combined real serializer/Store promotion tests extend the above RED-driven paths. They are coverage additions, not separately claimed initial RED cycles.

## Real DOCX evidence

- Real Tiptap content starts with a parsed DOCX fixture, receives a manual body edit and manual header plus an approved Agent find/replace. The uploaded ZIP contains `Agent edit.`, `Manual edit.`, and `word/header1.xml` containing `Manual header`.
- The checkpoint barrier test holds the persistence promise and observes no apply terminal before release, while a duplicate request causes only one body mutation. Both delivered results contain the same persistence reference after release.
- Combined renderer/production-driver/Store tests materialize and commit those complete DOCX bytes to a temporary recovery root. The original file remains byte-for-byte equal to the initial fixture before Save. A new parsed source is reconstructed from the stored head, then the normal file-action save path writes through a preparation checkpoint and promotion to the real original path.
- Both recovered-zero-input and recovered-plus-`Extra manual edit.` saves inspect the actual file ZIP. `Agent edit.` and `Manual edit.` occur once, the extra manual edit occurs exactly once when supplied, the header survives, Store dirty is false, savedRevision becomes 2, and renderer dirty is false.
- JSDOM lacked `CSS.escape` during the rebase stylesheet step; the test uses the same minimal browser API shim as existing Docs rendering tests. This was a test-environment issue, not a product serializer change.

## Verification and observed limitations

- Final driver gate: `npm run test -w @nexusdesk/local-host -- tests/docs-document-driver.test.ts` — **6/6 passed**. A stressed run hit the default five-second timeout on the fsync/restart/promotion case; that real disk test now allows twenty seconds. The final command completed in 2.67 seconds.
- Final renderer gate: `npm run test -w @genoffice/docs -- tests/docs-working-copy.test.ts tests/browser-agent-api.test.ts tests/browser-host-api.test.ts tests/browser-save-replay.test.ts tests/docs-save-adapter.test.ts tests/approved-save-guard.test.ts --maxWorkers=1` — **6 files / 48 tests passed**, exit 0 (52.81 seconds under concurrent workspace load).
- `npm run typecheck -w @nexusdesk/local-host` — **passed** after correcting the error-code union.
- `npm run typecheck -w @genoffice/docs` — **passed**.
- Default-parallel complete Docs run was interrupted after the unrelated `protect-dialog.test.ts > setting a modify password produces verifiable writeProtection credentials` exceeded its ten-second polling deadline.
- The requested single low-concurrency full Docs run (`--maxWorkers=2`) completed **263 files / 2526 tests: 2525 passed, 1 failed**. The sole failure was the stale-hydration RED test added while that run was executing. It subsequently passed in focused GREEN runs. All other 262 files, including ProtectDialog, passed in that run. Per controller instruction, the full suite was not repeated.
- A seven-file focused run passed 52/52 before the last coverage additions. A later stressed seven-file run passed all 48 task tests but the same unrelated ProtectDialog credential case timed out (55/56 total). Existing JSDOM canvas and React act warnings were also observed; no unrelated test or UI implementation was changed.
- Final isolated `npm run test -w @genoffice/docs -- tests/protect-dialog.test.ts --maxWorkers=1` — **8/8 passed**, followed by another **passing Docs typecheck** on the final files. `git diff --check` and Prettier checks on all eleven task source/test files passed.
- The one full Local Host run during parallel editor implementation completed 193/195: PDF capability baseline mismatch and a five-second Slides driver timeout. The controller owns the final serial aggregate run after other agents finish; neither failing file is in this task's scope.
- This task does not claim browser/Chromium crash/restart E2E; Task 5 owns that acceptance run. Host source leases and Store durability are used through the fixed shared contracts. Existing single-Host/cross-process writer limitations remain.
- After a session has accepted edits, recovery errors deliberately retain dirty content for user recovery; automatic reload is limited to a demonstrably unchanged initial hydration. The existing bounded exact-save snapshot limit is retained.

## Exact changed files and self-review

- `apps/local-host/src/docs-document-driver.ts`
- `apps/local-host/tests/docs-document-driver.test.ts`
- `apps/docs/src/renderer/App.tsx`
- `apps/docs/src/renderer/browser-host-api.ts`
- `apps/docs/src/renderer/file-actions.ts`
- `apps/docs/src/renderer/agent/browser-agent-api.ts`
- `apps/docs/src/renderer/agent/docs-save-adapter.ts`
- `apps/docs/src/renderer/agent/docs-working-copy.ts`
- `apps/docs/tests/browser-agent-api.test.ts`
- `apps/docs/tests/browser-host-api.test.ts`
- `apps/docs/tests/docs-working-copy.test.ts`
- This report.

Self-review checked all five brief review focuses, exact-save/approval behavior, source identity, in-flight duplicate ownership, no-result-before-receipt, no success journal on failure, binary transport, no original write from ordinary apply/timers, dirty preservation, and recovery-before-register. Shared protocol/client/coordinator/registry/router and Sheets/PDF source files were not modified or staged by this task. No subagents were spawned.

Ruling: use the controller-provided standalone brief/report as this task's ledger and leave the shared workspace intact; task/plan lifecycle scripts and branch-wide review are controller responsibilities. Ruling: limit automatic stale-source replacement to unchanged initial hydration; discarding new manual content would violate the brief's dirty-preservation requirement.
