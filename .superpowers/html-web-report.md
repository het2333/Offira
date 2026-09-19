# NexusDesk HTML Local Web report

## Delivered

- Registered `.html` and `.htm` files as exact-authority Local Host documents using the existing revision-checked UTF-8 text driver.
- Enabled shared Shell HTML tabs and preserved mounted editor frames.
- Installed a preload-shaped browser HTML API before the existing renderer mounts. It loads only `nexusdesk://<document-id>`, saves only through Host content writes, and advances revision only after a successful response.
- Kept the original source-editor and preview UI. The Web adapter serves preview content as a sandboxed data URL; native file dialogs, attachments, exports, fullscreen, and external fetches return typed `UNAVAILABLE_IN_WEB` errors rather than falsely succeeding.
- Added replay-safe browser editor registration and a native adapter over the existing HTML `apply_ops` DSL.
- Registered provider-neutral native Harness tools: `read_html`, `apply_html_operations`, and `save_html`. Results are bounded `AgentToolResult` envelopes and mutation remains proposal → exact one-time approval → apply.
- Updated renderer asset bases and Local Host roots so the Electron-built renderer output can be served under `/markdown/` and `/html/`.

## Verification

- `npm test -w @genoffice/html -- browser-host-api` — 3 passed.
- `npm test -w @nexusdesk/runtime-host -- html-tools runtime-policy` — 8 passed.
- `npm test -w @nexusdesk/local-host -- text-document-driver startup` — 4 passed.
- `npm test -w @nexusdesk/shell-ui -- editor-frame` — 4 passed.
- `npm run typecheck -w @genoffice/html`, `@nexusdesk/runtime-host`, and `@nexusdesk/local-host` — passed.
- `npm run build -w @genoffice/html` — passed; renderer output is present at `apps/html/out/renderer`.
- `npm run build -w @nexusdesk/runtime-host && npm run smoke -w @nexusdesk/runtime-host` — passed.

## Remaining risk

- A Chromium end-to-end save/reload and Agent-approved replay test was not added in this slice; browser API and protocol boundaries are unit-tested.
- Browser preview uses a data URL. It preserves the existing sandbox and supports current-source preview, but relative local image assets remain unavailable until a browser-safe asset contract is added.
