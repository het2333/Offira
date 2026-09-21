# Task 1 report: Sheets range reads

## Implementation

- Added `expandReadTargets(addresses, maxCells = 10000)` with strict bounded A1 parsing, Excel row/column limits, pre-allocation area accounting, row-major expansion, normalization, and de-duplication.
- `read_sheet` now expands ranges to individual cell keys before calling the reader. It no longer asks the existing single-cell reader for a range key such as `A1:C3`.
- Added an awaited `ensureCellsLoaded` command boundary. The live lazy-workbook handler reuses `ensureLazyRangeLoaded` for every requested bounded input range and refuses to read if hydration returns false or throws.
- Explicit `sheetId` values are validated against workbook sheets. When both a name and ID are present they must identify the same worksheet; neither path falls back to the active worksheet.
- Machine-facing live reads retain model `value`, `rawValue` when present, rendered `display` when different, and `formula` when present.
- No apply, mutation, save, browser refresh, or live document operation was performed.

## TDD evidence

### RED 1: target expansion module

Command:

`npm run test -w @genoffice/sheets -- tests/read-targets.test.ts`

Expected failure observed:

`Cannot find module '../src/renderer/agent/read-targets'`

Native prerequisite tests passed first (187 library + 6 binary tests); Vitest then failed because the new module did not exist.

### RED 2: command behavior

Command:

`npx vitest run tests/sheets-command.test.ts`

Expected failures observed (4):

- range reader received `C1:C3` instead of `C1`, `C2`, `C3`;
- `readCells` ran before the deferred hydration resolved;
- hydration rejection incorrectly returned `{ ok: true }`;
- an unknown explicit sheet ID incorrectly returned `{ ok: true }`.

### RED 3: conflicting explicit identity

Command:

`npx vitest run tests/sheets-command.test.ts`

Expected failure observed: `sheet: Summary` plus `sheetId: sheet-2` incorrectly returned `{ ok: true }`.

### GREEN

Focused command:

`npx vitest run tests/read-targets.test.ts tests/sheets-command.test.ts tests/univer-range-loading.test.ts tests/working-copy-hydration.test.ts tests/revision-tracker.test.ts`

Result: **5 files passed, 47 tests passed**.

This covers per-cell `C1/C2/C3` values `1/2/3`, delayed hydration ordering, hydration exception handling, formula/computed/raw preservation, strict worksheet identity, existing lazy hydration, working-copy hydration, and revision behavior.

## Broader verification and failures outside the focused tests

- `npm run typecheck -w @genoffice/sheets` reached the existing dirty `tests/browser-host-api.test.ts` and failed only on missing `@types/jsdom` (`TS7016`). No Task 1 type error was reported.
- `npm test -w @genoffice/sheets` passed all native tests/build, then the broad Vitest run exposed these failures before being stopped to avoid blocking review. Their pre-existing status is unverified except where noted:
  - `xlsx-sidecar-cancel.test.ts`: `close sweeps the session queued reads with cancels ahead of the close`;
  - `pivot-roundtrip.e2e.test.ts`: LibreOffice executable missing;
  - `working-copy-payload.test.ts`: large UTF-8 bounded-parts round trip (known prior failure);
  - `browser-host-api.test.ts`: structured proposal approval test (file was already dirty outside this task; failure baseline otherwise unverified);
  - `xlsx-save-edits.test.ts`: 100k insert/overwrite test timed out at 120 seconds.
- Full suite was interrupted after recording those failures; exit code 130. Focused Task 1 and hydration/revision tests remain green.

## Files

- `apps/sheets/src/renderer/agent/read-targets.ts`
- `apps/sheets/src/renderer/agent/sheets-command.ts`
- `apps/sheets/src/renderer/App.tsx` (only Task 1 hunks staged/committed; pre-existing dirty hunks preserved)
- `apps/sheets/tests/read-targets.test.ts`
- `apps/sheets/tests/sheets-command.test.ts`

## Concerns

- The full Sheets suite is not globally green for the failures above; most are outside focused Task 1 coverage and their baseline status is unverified.
- `App.tsx` had pre-existing edits; Task 1 uses a partial-index commit so those existing working-tree changes are not included.

## Round 1 review fix: ID-form conflict

The reviewer found that `sheet: "sheet-1"` took the direct ID branch before the simultaneously supplied `sheetId: "sheet-2"` was checked.

RED command:

`npx vitest run tests/read-targets.test.ts tests/sheets-command.test.ts`

Observed result: **1 failed, 12 passed**. The new `rejects conflicting explicit worksheet ids in sheet and sheetId` regression received `{ ok: true }` instead of `SHEET_NOT_FOUND`.

After resolving and comparing both explicit references before the direct-ID return, the same command was rerun.

GREEN result: **2 files passed, 13 tests passed**.
