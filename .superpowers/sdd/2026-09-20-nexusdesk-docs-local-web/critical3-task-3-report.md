# Critical 3 Task 3 — Sheets implementation report

Status: DONE_WITH_CONCERNS. Base: `1a8b6ed8e4f899d0d5c72c685bb1ae4866b4295e`.

## Delivered behavior

- `createSheetsDocumentService(repositoryRoot, path, { workingCopyRoot? })` now exposes the existing Store through a working-copy port. Source bytes are verified immutable snapshots, and native sessions are opened on those snapshots. Checkpoint materialization never replaces the live session, clears renderer journals, or writes the authorized original.
- A complete pure `buildWorkbookSavePlan` is shared with Electron. It retains edits, bulk fills, structural operations, charts, visual edits/additions, tables, pivots, sheet add/duplicate/rename/remove/order, filters, hyperlinks, CF/DV, page setup, notes, pivot refresh paths/updates/relayout, protection, sparklines, formula caches, defined names and theme state. Electron keeps its existing staging and save/session flow.
- `buildWorkingCopyPayload` captures without UI or save side effects. Lists, including nested note/rule/name/pivot lists, use UTF-8 byte-bounded JSON parts (256 KiB each); images use raw asset parts. A scalar record above the part limit is rejected; the aggregate limit is 128 MiB. The Web adapter does not use the old Electron edits-transfer action or inline item cap.
- Materialization performs structural edits and held table/pivot/name additions entirely in an isolated temporary XLSX, validates the final file by opening it with the real sidecar, and returns only final bytes to the coordinator. Failure in phase two cannot publish phase one. Unsupported held operations involving newly added sheets are refused during proposal preflight with a Save/reload instruction.
- Recovery bootstrap opens a new source-native session. Range, formulas, recalculation, media and pivot definition reads use that same session/snapshot; obsolete or foreign session IDs are rejected. A bootstrap/source-lease race fails explicitly with `REVISION_CONFLICT`, instead of pairing old workbook metadata with a new head.
- Browser apply awaits capture, upload, materialization and receipt before returning success. Durable lookup precedes proposal checks and never re-executes an already committed mutation. Old journals without receipts cannot replay success. Apply/capture and manual/Agent Save share the mutation lane; the capture lock and exact Save snapshot check prevent edits entering an approved snapshot late.
- The App waits for workbook installation and initial hydration before registration. Volatile undo changes no longer publish disk revisions; proposal snapshots detect manual changes independently. Recovery Save remains enabled with an empty journal, uses the coordinator's manual-save/promotion path, then reopens and rebases the native source. A committed Save remains successful if reopening fails, with an explicit reload message.
- `recovery:required` triggers local bounded rebootstrap/reopen (three attempts), keeps registration gated until actual App hydration, and exposes failure instead of continuing against old content.

## RED → GREEN evidence

1. New mapping/payload module tests first failed because the required exports/modules did not exist; extraction and codec made them green.
2. Four real service tests first failed at missing `driver.workingCopy`. They now exercise fixed S → A → cumulative A+B, isolated second-phase failure, restarted native session/recalc/empty-journal promotion, and the bootstrap/source race.
3. Durable bridge tests first failed because capture was never called and replay rejected the missing proposal. They now prove that no `ok` is delivered before the receipt, and that durable historical lookup avoids another mutation.
4. Host tests first failed on eager registration/missing manual-save integration. Hydration gating and binary manual Save now pass, including empty restored journal and reopening.
5. Manual-edit stale-plan test first returned `ok`; the independent content snapshot now refuses it with `STALE_CONTENT` despite unchanged durable revision.
6. Save capture-race test initially reached checkpoint with changed content; exact snapshot revalidation under the lock now prevents the write.
7. Recovery-frame test initially never reopened; bounded local rebootstrap now opens the new native session and waits for hydration before registering.
8. Nested metadata-list test initially rejected a large notes list as one record. Recursive list chunking now round-trips 600 notes, and image content is verified in raw asset parts rather than base64 JSON.
9. The unsupported new-sheet/held-operation preflight test first failed on the missing validator; the real validator now rejects those plans before application.

## Real XLSX / native-sidecar evidence

`apps/local-host/tests/sheets-document-service.test.ts`: 8/8 pass using the production service, real `XlsxSidecarClient`, real temporary XLSX files, ZIP inspection and Store commits/promotions.

- Cumulative A+B on fixed S leaves the original `Hello` at A2 (one inserted row), and has exactly one new chart in addition to the fixture's orphan chart. Original file bytes are unchanged, and the old live session still reads `Hello`.
- Duplicate held table additions cause phase-two failure; the Store head stays null and original bytes stay equal.
- Restarted service reports `restoredFromRecovery: true`, rejects the former session, recalculates B3 from recovered C1=17, reads the original formula, promotes the checkpoint, and reopens a clean new session.
- A complete metadata fixture checks the written ZIP for formula `<f>` plus `<v>34</v>`, bulk fill, filters, CF/DV, page orientation, sheet/workbook/protected-range protection, hyperlinks, sparklines, comments, defined names, native tables and native pivots. Recovery reads image bytes and pivot definitions through the new session.
- Added/renamed/reordered sheets and new-sheet cell values are verified in workbook/worksheet XML.
- 21,001 edits with multibyte Chinese/emoji content exceed 2 MB, pass through binary parts, generate A21001 in the actual XLSX, and commit a dirty checkpoint.

## Verification

- `npm run native:build -w @genoffice/sheets`: PASS (release native executable).
- Native tests run by Sheets `npm test`: 187 library + 6 binary tests PASS.
- `npm run test -w @nexusdesk/local-host -- tests/sheets-document-service.test.ts --maxWorkers=1`: 8/8 PASS.
- The seven brief-named Sheets test files through `npm run test -w @genoffice/sheets -- ... --maxWorkers=2`: 7 files, 67/67 PASS on the final run.
- `npm run typecheck -w @genoffice/sheets`, `npm run typecheck -w @genoffice/xlsx-gateway`, `npm run typecheck -w @nexusdesk/local-host`: all PASS on the final run.
- Full Local Host suite (`--maxWorkers=1`): 24 files, 208/208 PASS.
- Full Sheets suite (`--maxWorkers=2`): 254 files pass / 3 files fail; 2812 tests pass / 3 fail. An earlier unconstrained run was interrupted after resource congestion; the bounded run completed. See concerns below.
- Independent repeat of `xlsx-save-edits.test.ts` and `xlsx-sidecar-cancel.test.ts`: 38 pass, 1 fail. All 36 save-edits tests, including the 100k performance probe, pass independently.
- `git diff --check` within task scope: PASS. Self-review completed; no shared protocol, web-client, coordinator, registry/router, Docs or PDF files changed by this task.

Logs retained in this task workspace: `critical3-task-3-gate.log`, `critical3-task-3-host-full.log`, `critical3-task-3-sheets-full-bounded.log`; the aborted initial run is `critical3-task-3-sheets-full.log`.

## Concerns and limits

1. Full Sheets is not wholly green in this environment. `pivot-roundtrip.e2e.test.ts` → “survives a headless convert with the pivot parts intact” fails because `/opt/homebrew/bin/soffice` points to missing `/Applications/LibreOffice.app/Contents/MacOS/soffice`. No system installation or unrelated test changes were made.
2. `xlsx-sidecar-cancel.test.ts` → “close sweeps the session queued reads with cancels ahead of the close” still fails independently: the synchronous fake PassThrough read contains one `read_range`, versus the expected two reads/cancel/close. Both that test and `xlsx-sidecar-client.ts` are unchanged from BASE. This is reported, not hidden by weakening its assertion.
3. The full-suite `xlsx-save-edits.test.ts` 100k stress probe measured 30,907 ms against a 30,000 ms assertion under concurrent load; its independent repeat passed. No performance threshold was changed. Node 26 emits the existing experimental localStorage warning in renderer tests.
4. Shared-layer architecture is unchanged. Ruling: native bootstrap and subsequent source lease are bound and revalidated in this driver; a moved head requires a retry. A future coordinator-first bootstrap could simplify this ordering, but correctness does not depend on that refactor.
5. The existing Store has no cross-process writer lease. The supported configuration remains one Local Host writer per recovery document/root. This task does not claim cross-process linearizability or low-memory streaming; the 128 MiB cap still permits substantial in-memory materialization.
6. Browser E2E integration is Task 5's responsibility; this task provides the production factory and native/bridge coverage for it. Newly added-sheet held table/pivot combinations retain the documented Save/reload requirement, now checked before Agent proposal application.

## Exact changed files

- `apps/local-host/src/sheets-document-service.ts`
- `apps/local-host/tests/sheets-document-service.test.ts` (the prior native bootstrap test is retained)
- `apps/sheets/src/shared/workbook-save-plan.ts` (new)
- `apps/sheets/src/main/sheets-main.ts` (pure mapping extraction only)
- `apps/sheets/src/renderer/working-copy-payload.ts` (new)
- `apps/sheets/src/renderer/save-actions.ts`
- `apps/sheets/src/renderer/browser-host-api.ts`
- `apps/sheets/src/renderer/agent/browser-agent-api.ts`
- `apps/sheets/src/renderer/App.tsx`
- `apps/sheets/tests/workbook-save-plan.test.ts` (new)
- `apps/sheets/tests/working-copy-payload.test.ts` (new)
- `apps/sheets/tests/browser-host-api.test.ts`
- `apps/sheets/tests/browser-save-replay.test.ts`
- `.superpowers/sdd/2026-09-20-nexusdesk-docs-local-web/critical3-task-3-report.md`

## Review fix round 1 — four Important findings

The controller authorized this round to extend the previously frozen shared interface narrowly for exact native-session activation. The optional protocol/web-client `editorSessionId` wire was delivered separately in `f12226f`; this round consumes that wire and changes the optional driver port, bootstrap token forwarding and coordinator activation transaction. Docs/PDF/registry/router files are not changed by this round.

### Fixes and RED evidence

1. **Save lock through real hydration.** Manual and approved Agent Save now retain both the command veto and the inert document through receipt, delayed bootstrap, workbook installation and the awaited hydration promise. Trusted file installation gets a synchronous-only capability; the capability is cleared before asynchronous continuations. The Agent regression first failed with `locked === false` inside the delayed reopen. The manual regression now attempts an actual command during both delayed bootstrap and hydration and observes the veto; the independent lock test proves trusted synchronous installation cannot leave the bypass open for a later edit. A persisted Save still reports success with a reload warning if reopening fails.
2. **Strict Web recovery hydration.** Web open returns an actual completion promise, and reopen checks that the matching session confirmed hydration. Recovery range reads poll boundedly until `indexingComplete: true`; viewport, frozen-column and required full-preload read failures propagate. Mandatory pivot reads no longer swallow failure in Web recovery. The registration gate stays closed and manual Save is refused when hydration fails; the recovery frame loop retries at most three times. Ordinary Electron open retains its existing non-blocking/best-effort flow. New helper tests first failed because the strict API did not exist; real `loadVisibleRange`/`preloadEntireWorkbook` tests now prove HTTP 503 propagation and that 200 incomplete-index reads install no loaded range. Browser tests verify three failed installs produce no registration.
3. **Nested-list part budget.** Small nested arrays stay inline; growing lists are byte-chunked and raw image assets remain binary. The encoder checks part IDs/uniqueness and the 4096-part budget before returning a payload, and the decoder checks IDs/count before parsing. The 5000-rich-edit RED produced exactly 5004 parts; it now round-trips within the shared budget, as does a 5000-row pivot with nested member tuples. Oversized scalar and aggregate byte limits remain enforced.
4. **Request-bound candidate sessions.** Bootstrap creates a session candidate without retiring the live owner. Server/coordinator forwards the exact bootstrap native session to `acquireSource`; no latest-bootstrap singleton remains. Registration first passes ownership/head validation, then activates precisely that session/source. Activation failure restores the previous registration/lease when present and never publishes a new lease; rejected candidates are discarded without closing the active owner. A same-source native-session replacement changes lease generation so pending old-session uploads cannot commit. Only the active native session can materialize checkpoints. Candidates have a ten-minute lifetime and a 64-session service bound. The native RED failed because B's bootstrap made A's range read throw “obsolete workbook session”; the coordinator RED showed no activation invocation. The real service/coordinator regression now proves B is rejected with `WRONG_CLIENT`, B's candidate is cleaned, and A still reads, recalculates and materializes. A moved head between lease issuance and activation cleans the candidate while keeping A readable, and a later valid candidate can activate and retire A.

### Scope and remaining limits

- This round uses the test-driven-development, systematic-debugging and verification-before-completion workflows recorded above; all four review issues have focused regression coverage.
- The previous full-Sheets environment failures remain documented above; this round does not claim to have repaired LibreOffice, unrelated sidecar cancellation tests or the pressure-test timing threshold.
- Whole-browser fidelity/interaction E2E remains the integration task's gate. Native service, real renderer loading entry points, host/bridge behavior and ownership integration are covered here.

### Fix-round verification

- Expanded Sheets gate: the prior seven brief-named files plus strict hydration and approved-save-lock tests, **9 files / 78 tests PASS** on the final run.
- Native tests/build through `npm run test -w @genoffice/sheets`: **187 library + 6 binary tests PASS**, release build PASS.
- Production native service **10 tests PASS**; coordinator **23 tests PASS**, including same-source native-session lease invalidation.
- Full Local Host: **24 files / 212 tests PASS** on the final run.
- Typecheck: Sheets, XLSX gateway and Local Host **all PASS**.
- Targeted ESLint: **0 errors**, with the same three existing App hook warnings at lines 2905, 2906 and 2917. No unrelated effect rewrites were made. `git diff --check`: PASS.
- An extra root browser-host API compatibility run passed **6 files / 61 tests**, including the other editor hosts.
- Full Sheets was not rerun in this round; its previous 2812-pass / 3-known-failure evidence and limitations remain above.
