# Critical 3 Task 4 — PDF working-copy implementation report

BASE: `1a8b6ed8e4f899d0d5c72c685bb1ae4866b4295e`

## Delivered

- Production PDF Driver exposes `workingCopy` with configurable `workingCopyRoot`, immutable Store source acquisition/read, raw asset decoding, complete `applySaveRequest` validation, and parsed final PDF verification. Skipped text edits, insertions, or image edits reject materialization before any checkpoint terminal.
- `capturePdfWorkingCopy()` freezes the supplied save request synchronously. `buildPdfSaveRequest()` derives all buckets, page order, static forms and stamps from the exact reducer post-state. JSON parts are bounded by UTF-8 bytes, images use raw asset parts, and an oversized indivisible record fails explicitly. Existing image and total save-envelope product limits remain enforced.
- Renderer applies and captures on one mutation lane, publishes `editor:result.ok` only with the returned durable receipt, uses the shared bounded receipt journal, and looks up uncertain outcomes without reapplying. Throwing storage does not change a successful persisted result. React replacing an adapter during asynchronous snapshot verification cannot redirect the operation into another closure.
- Initial hydration and rebase load the version-bound source. PDF bytes, image listings, image pixels, static form metadata, and annotation object references use that source. The live renderer keeps its original source while pending operations accumulate; checkpoint head changes do not rebase it implicitly.
- `recoveryDirty` survives restored empty pending buckets and drives an explicit Save. An unchanged restored PDF promotes the existing checkpoint without incrementing the working revision. Agent Save and manual Save both use coordinator persistence and then rebase. Recovery dirty clears only after successful loading. A committed save followed by PDF reload failure remains successful with a separate reload error.
- `modify_pdf_pages` captures pending edits plus the approved page modification in one payload. The shared coordinator's already-authorized rewrite branch prepares and promotes that complete PDF. The external operation retains a `dirty:false` save receipt. Ordinary apply only checkpoints and leaves the original file unchanged.
- Saved IDs, note contents and the final page remap are captured for Agent Save/rewrite, preserving later pending edits through existing `loadDoc(..., savedSnapshot)` subtraction and note remapping.
- `recovery:required` automatically starts bootstrap → load → hydrate → register, with at most three consecutive recovery attempts. A failed recovery shows an explicit refresh error. Rendering an old source cannot register while a new bootstrap is loading; editing remains disabled until the Host confirms hydration. Dirty checkpoint revisions are retained for reconnect registration.

## RED → GREEN evidence

1. Driver test initially failed with `driver.workingCopy` undefined; immutable-source materialization passed after implementation.
2. Capture tests initially failed with missing `capturePdfWorkingCopy` / `buildPdfSaveRequest`; now verify frozen post-state, all three image locations in raw parts, UTF-8 part limits, and manual text plus approved markup/rotation/order before React rerender.
3. Browser tests initially failed because storage `getItem` threw during delivery, and recovery reads used `/content` instead of the leased source. Both now pass, with success delayed until checkpoint completion and one application for concurrent requests.
4. Recovered empty-pending Save initially registered immediately and lacked a recovery-dirty/promotion path. It now waits for hydration, uses manual-save uploads, and retains dirty until the saved source is loaded.
5. Rebase race test initially emitted a second registration for the old PDF while bootstrap was pending. It now rejects both the pending bootstrap and a mismatched loaded source.
6. Unknown-outcome test initially executed a second mutation; subsequent mutations now fail with a recovery-required result while an earlier outcome is unknown.
7. Unchanged static-form metadata initially forced a nonempty save plan. It is now omitted unless image/structural edits require updating it. Driver static-form recovery initially failed as unsupported and now reads the leased PDF source.
8. Stale-source recovery test initially made zero bootstrap requests; it now reloads automatically and stops after three unconfirmed recovery attempts. Host-confirmation test initially exposed an interactive editor before registration acknowledgement; it now remains busy until acknowledgement.
9. Dirty checkpoint test initially retained no updated registration; it now registers the current working revision with the original source and latest checkpoint ID.
10. A recovered committed save initially became `EDITOR_REQUEST_FAILED` when renderer reload failed. It now returns the original successful durable result with `PDF_RELOAD_FAILED`, without another save application.
11. Async adapter-switch test initially returned `unverified replacement`; it now applies on the adapter whose snapshot was verified. Saved-snapshot test initially lacked a helper and now preserves exact saved IDs and insertion-adjusted page remaps.
12. Full Local Host regression exposed `pdf-capabilities.test.ts` baseline conflict after trusted direct `execute('save')`. The compatibility write path now also uses Store preparation/promotion; the unchanged regression passes.
13. Recovery retry initially lost the loader when a transient bootstrap error caused React to detach its adapter. Recovery now retains that attempt's loader, and a succeeding retry restores the ready state.

The new parser and crash tests also exercise the reused production Store/coordinator implementation, rather than replacing it with fixtures. Fixture corrections during development were a zero-based page index, the existing `FormValueInput.kind` property, and the Store receipt's existing `dirty` discriminant (it has no `kind`). These are not claimed as production RED failures.

## Real PDF evidence

- PDF.js independently extracts exactly one `Manual` text item from bytes written by the PDF applicator.
- pdf-lib parses final annotations, one highlight, page counts/order, 90° rotation, metadata, and the filled `Name` AcroForm value `Ada`.
- PDFium-backed image inspection sees exactly two final page images (insert plus stamp), and recovered-source pixel reads produce actual PNG data.
- Cumulative A → B uses immutable S and does not duplicate text/notes/highlights/images/rotation/deletion/order. Reload then edits and deletes the restored note by its recovered reference while preserving the highlight. Looking up A leaves B at working revision 3.
- Original file bytes remain identical throughout ordinary checkpoints. Recovered empty-pending manual Save writes the checkpoint bytes exactly and advances saved revision only.
- Production coordinator fault injection at save intent, original-file rename, and final receipt durability followed by a fresh Driver/Store produces exactly two pages from a one-page input, retains the pending note once, and returns the same successful page-rewrite terminal on repeated lookup.

## Verification

- `npm run test -w @genoffice/pdf -- tests/pdf-working-copy.test.ts tests/browser-agent-api.test.ts tests/browser-host-api.test.ts tests/note-edit-save.test.ts tests/note-reply-save.test.ts`: 5 files, 34 tests passed.
- `npm run test -w @nexusdesk/local-host -- tests/pdf-document-driver.test.ts`: 19 tests passed.
- `npm run test -w @genoffice/pdf`: 54 files, 821 tests passed.
- Complete Local Host suite with `--maxWorkers=1`: 24 files, 208 tests passed.
- `npm run typecheck -w @genoffice/pdf` and `npm run typecheck -w @nexusdesk/local-host`: passed after final implementation/formatting.
- Scoped ESLint: 0 errors; 3 existing App hooks warnings (`resolveDocFont`, `t`, and an unused exhaustive-deps disable directive). `git diff --check` passed.

An initial complete Host run failed the PDF direct-save compatibility regression above, which was fixed. A later default-concurrency run passed all PDF checks but hit the existing 5-second timeout in these Slides tests: `rejects a structurally named but unparsable presentation before changing the live deck`, `opens, edits, and saves one real PPTX session in place`, and `validates and saves an Agent transaction result in the isolated service`. The full suite passed with one worker. One run of the multi-engine PDF parser test also exceeded its original 5-second timeout under concurrent builds; that specific parser test now allows 20 seconds and passes. No Slides implementation or tests were modified.

PDF's complete suite continues to print existing jsdom `HTMLCanvasElement.getContext` warnings and duplicate `loadURL` fixture-key warnings in `auto-rename.test.ts` and `open-path.test.ts`; those tests pass.

## Rulings and limitations

- Ruling: preserve the direct trusted Host Driver save API for existing callers, but route its writes through Store preparation/promotion. Public HTTP direct-write paths remain rejected by the shared working-copy gate. This compatibility API is not the renderer's approval/replay entry point.
- Ruling: disable unattended autosave only in working-copy Web mode. The brief authorizes original-file replacement through an explicit Save or the explicitly approved page rewrite; Electron's existing autosave behavior remains unchanged.
- Ruling: keep the existing PDF image and JSON-envelope limits while transporting images as binary. No isolated checkpoint-only bypass or silent truncation was introduced.
- The shared Store's single-Host and in-memory materialization limits remain; this task does not introduce a cross-process writer lock or claim low-memory streaming.
- Full browser acceptance is the explicitly separate Task 5. This task verifies real production serializer/Store/coordinator paths plus renderer bridge/transport behavior, not a completed browser E2E release gate.
- Self-review was performed locally as requested; no child agents were created. Shared protocol, web-client, coordinator, registry, router, Docs and Sheets files were not modified by this task.

## Exact task files

1. `apps/local-host/src/pdf-document-driver.ts`
2. `apps/local-host/tests/pdf-document-driver.test.ts`
3. `apps/pdf/src/renderer/App.tsx`
4. `apps/pdf/src/renderer/agent/browser-agent-api.ts`
5. `apps/pdf/src/renderer/agent/pdf-working-copy.ts`
6. `apps/pdf/src/renderer/browser-host-api.ts`
7. `apps/pdf/src/shared/working-copy.ts`
8. `apps/pdf/tests/pdf-working-copy.test.ts`
9. `apps/pdf/tests/browser-agent-api.test.ts`
10. `apps/pdf/tests/browser-host-api.test.ts`
11. `.superpowers/sdd/2026-09-20-nexusdesk-docs-local-web/critical3-task-4-report.md`

Existing note-edit/save and note-reply/save regression files were run unchanged.
