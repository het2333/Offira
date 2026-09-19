# NexusDesk Markdown Local Web report

## Delivered

- Added a revision-checked, atomic UTF-8 text Local Host driver and registered `.md`, `.markdown`, and `.mdown` startup files.
- Added the shared Shell Markdown frame route, preserving mounted editor frames.
- Added a preload-shaped Markdown browser API which loads only Host-authorized bytes, saves in place through the content route, and advances revision only after a successful Host response.
- Added the replay-safe browser editor bridge and Markdown adapter over the existing `apply_ops` DSL.
- Registered native Harness tools: `read_markdown`, `apply_markdown_operations`, and `save_markdown`. Tool output is projected to `AgentToolResult` and mutations retain proposal → one-time approval → apply semantics.
- Configured the Markdown renderer to build to `apps/markdown/out/web` with `/markdown/` asset URLs.

## Verification

- `npm test -w @genoffice/markdown -- browser-host-api browser-agent-api markdown-editor-adapter` — 6 passed.
- `npm test -w @nexusdesk/local-host -- text-document-driver startup` — 4 passed.
- `npm test -w @nexusdesk/runtime-host -- markdown-tools runtime-policy` — 7 passed.
- `npm test -w @nexusdesk/shell-ui -- editor-frame` — 4 passed.
- Typecheck passed for Markdown, Local Host, and Runtime Host.
- Shell UI typecheck retains a pre-existing branded-type test error at `tests/editor-frame.test.tsx:70` for its existing Docs fixture; the new Markdown assertion is cast to the existing test convention.
- Markdown build passed before the Web-output configuration change; a final renderer build was started after the configuration adjustment but exceeded the command window while Vite transformed its large Mermaid bundle. The configuration is a direct mirror of the working Docs Web output configuration.

## Remaining risk

- HTML is intentionally not registered or routed yet: its renderer needs the analogous browser adapter and native Harness tool bridge. The shared text driver supports it for the follow-up milestone, but Local Host only advertises Markdown to avoid exposing a non-working frame.
- Full Chromium save/reload and Agent-approved operation replay remain to be added for Markdown.
