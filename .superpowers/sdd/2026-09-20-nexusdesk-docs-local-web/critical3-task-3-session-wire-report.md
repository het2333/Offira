# Critical 3 / Task 3: editor session wire report

## Scope

- Added optional `editorSessionId` to `EditorRegisterFrame`.
- Added strict protocol validation: non-empty string, maximum 256 characters.
- Added `EditorRegistrationHandle.setEditorSessionId(id: string | null)`.
- Registration now carries the current non-null editor session ID, re-registers with a new request ID after a ready/hydrated change, omits the field after clearing, and reuses the current ID after reconnect.

## TDD evidence

- Protocol RED: `schemas.test.ts` failed because strict parsing rejected `editorSessionId` as an unrecognized key.
- Protocol GREEN: focused schema test passed after adding the frame field and bounded schema.
- Web-client RED: four focused client tests failed because `setEditorSessionId` did not exist.
- Web-client GREEN: all focused client tests passed after adding the minimal state and resend behavior.

## Verification

- `npm run test -w @nexusdesk/protocol`: 2 files, 13 tests passed.
- `npm run test -w @nexusdesk/web-client`: 4 files, 31 tests passed.
- `npm run typecheck -w @nexusdesk/protocol`: passed.
- `npm run typecheck -w @nexusdesk/web-client`: passed.
- ESLint over the five changed TypeScript files: passed.
- `git diff --check` over the five changed TypeScript files: passed.

An additional direct Prettier check reports style warnings in four touched files. The corresponding `HEAD` versions already differ from direct Prettier output, so no broad formatting rewrite was included in this narrow change.

## Intended commit files

- `packages/nexusdesk-protocol/src/frames.ts`
- `packages/nexusdesk-protocol/src/schemas.ts`
- `packages/nexusdesk-protocol/tests/schemas.test.ts`
- `packages/nexusdesk-web-client/src/editor-registration.ts`
- `packages/nexusdesk-web-client/tests/client.test.ts`
- `.superpowers/sdd/2026-09-20-nexusdesk-docs-local-web/critical3-task-3-session-wire-report.md`

No `apps/local-host` or `apps/sheets` files are part of this task's changes or intended commit.
