# PDF Local Web vertical slice

## Delivered path

The Local Host now recognizes authorized `.pdf` files and exposes revisioned
`application/pdf` content. The original PDF renderer runs under `/pdf/` with a
preload-shaped browser adapter. Its existing pending-edit DSL is preserved, and
an in-place save posts the renderer's `SavePdfRequest` back to the Host, where
the existing `applySaveRequest` implementation applies it and atomically
replaces the authorized file.

The browser bridge registers PDF with the native Harness and exposes only the
curated `read_pdf`, `apply_pdf_operations`, and `save_pdf` tool catalog. PDF
mutations are one-time approved, plan-hash bound, and operation-idempotent.
The Local Host router independently enforces `save_pdf` approval; it does not
trust the runtime tool to have requested it.

## TDD evidence

Initial RED tests established the missing PDF driver, browser host adapter,
browser agent bridge, and Harness tool catalog before their implementations.
The implemented tests are:

- `apps/local-host/tests/pdf-document-driver.test.ts`
- `apps/pdf/tests/browser-host-api.test.ts`
- `apps/pdf/tests/browser-agent-api.test.ts`
- `packages/nexusdesk-runtime-host/tests/pdf-tools.test.ts`

The additional Local Host approval regression tests deliberately removed
`save_pdf` from the router mutation allowlist. The focused suite then failed as
expected: the unapproved and mismatched-plan PDF saves no longer threw
`no matching one-time approval`. Restoring the allowlist made the same suite
green. The tests cover no approval, a mismatched plan hash, and a repeated
completed operation id that is not delivered to the editor a second time.

## Verification

Successful fresh commands:

- `npm run test -w @nexusdesk/local-host` — 65 tests
- `npm run test -w @nexusdesk/runtime-host` — 20 tests
- `npm run test -w @nexusdesk/web` — 15 tests
- `npm run test -w @nexusdesk/shell-ui` — 8 tests
- `npm run typecheck -w @nexusdesk/local-host`
- `npm run typecheck -w @nexusdesk/runtime-host`
- `npm run typecheck -w @nexusdesk/web`
- `npm run typecheck -w @nexusdesk/shell-ui`
- `npm run typecheck -w @genoffice/pdf`
- `npm run build -w @nexusdesk/runtime-host && npm run smoke -w @nexusdesk/runtime-host`
- `npm run build:web-renderer -w @genoffice/pdf`
- `npm run build:web`

The root `build:web` composition completed successfully and includes the PDF
renderer build before the browser shell and Local Host bundle, so the Host's
`/pdf/` static route receives the actual production renderer artifact.

The full PDF suite has one unrelated environment-sensitive failure:
`tests/text-insert-fallback.test.ts` expects U+0378 to be absent from every
installed font, but the current macOS font index maps it. The unchanged
`@genoffice/font-metrics` U+0378 test fails for the same reason. The PDF suite
otherwise passes 774 of 775 tests. Existing canvas and duplicate-object-key
warnings were also emitted by unrelated PDF tests.

## Web limitations (explicitly unavailable)

The browser path refuses or reports typed unavailability for native-only work:

- arbitrary filesystem paths, native file pickers, and Save As
- permanent redaction and native file-level operations
- OS OCR, font enumeration, image extraction, or pixel editing
- native print/export/conversion and Electron provider UI
- external data/network generators and native-only login features

`save_pdf` remains in-place only and targets the Host-authorized document.
