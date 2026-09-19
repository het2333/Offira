# NexusDesk Markdown Local Web report

## Delivered

- Added a revision-checked, atomic UTF-8 text Local Host driver and registered `.md`, `.markdown`, and `.mdown` startup files.
- Added the shared Shell Markdown frame route, preserving mounted editor frames.
- Added a preload-shaped Markdown browser API which loads only Host-authorized bytes, saves in place through the content route, and advances revision only after a successful Host response.
- Added the replay-safe browser editor bridge and Markdown adapter over the existing `apply_ops` DSL.
- Registered native Harness tools: `read_markdown`, `apply_markdown_operations`, and `save_markdown`. Tool output is projected to `AgentToolResult` and mutations retain proposal → one-time approval → apply semantics.
- Configured the Markdown renderer to build to `apps/markdown/out/web` with `/markdown/` asset URLs.
- Host routing now treats `save_markdown` as a mutation: no approval, a mismatched plan hash, and a replayed approval are rejected before the editor receives a request.
- The Markdown adapter records the live editor content version at proposal time and rejects an approval if a manual editor transaction changes that version before apply.

## Verification

- `npm test -w @genoffice/markdown -- browser-agent-api markdown-editor-adapter` — 5 passed.
- `npm test -w @nexusdesk/local-host -- agent-router text-document-driver document-content` — 18 passed.
- `npm test -w @nexusdesk/runtime-host -- markdown-tools runtime-policy` — 7 passed.
- `npm test -w @nexusdesk/shell-ui -- editor-frame` — 4 passed.
- Typecheck passed for Markdown, Local Host, and Runtime Host.
- Shell UI typecheck retains a pre-existing branded-type test error at `tests/editor-frame.test.tsx:70` for its existing Docs fixture; the new Markdown assertion is cast to the existing test convention.
- `npm run build:web -w @genoffice/markdown` — passed, producing `apps/markdown/out/web`.

## Remaining risk

- Chromium save/reload and Agent-approved operation replay coverage remains to be added for Markdown.
