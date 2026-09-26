<p align="center">
  <img src="apps/web/public/offira-mark.svg" alt="Offira" width="72" height="72">
</p>

<h1 align="center">Offira</h1>

<p align="center">
  <strong>Open Office files on your computer. Edit with AI.</strong><br>
  A local-first web workspace with DeepSeek Harness integration.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#demo">Demo</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#project-status">Project status</a>
</p>

> **Development preview:** Offira currently runs as a local web service on your computer. There is no downloadable installer, hosted demo, cloud sync, or collaboration service yet.

[▶ Watch the demos in this README](#demo) · [Play Excel directly](https://github.com/user-attachments/assets/7507bada-e64f-40e8-9817-b17a019c0b82) · [Play Docs directly](https://github.com/user-attachments/assets/aea696c7-7c1e-4d7e-afdd-811dd11d9a5d) · [Play Slides directly](https://github.com/user-attachments/assets/a3a3c93b-2f73-44b9-be67-8f40109d6c3b)

## Features

- **One workspace for your files.** Open documents, spreadsheets, presentations, PDFs, Markdown, and HTML from a shared home screen with file tabs and editor switching.
- **AI alongside your work.** Docs, Sheets, and Slides have DeepSeek Harness conversations, model selection, and native, document-aware tools. Editor operations are not routed through an MCP bridge.
- **Your choice of model provider.** Add API keys in **Settings → AI Models**, then choose an available model in the chat panel. Keys are stored by the local Harness credential service and are not echoed to the browser. Keys supplied through the startup environment remain read-only.
- **Review before writing.** Changes require approval. The Local Host binds each action to a file and session; when a write outcome is unknown, it checks the result instead of automatically submitting the operation again.
- **Local-first, with a clear network boundary.** Files and the web service run on your computer. Requests to an online model are sent to the provider you select; “local web” does not mean that every byte stays on-device.

| Editor              | File types             | Current AI integration                                      |
| ------------------- | ---------------------- | ----------------------------------------------------------- |
| Docs                | `.docx`                | Native document tools and Harness sidebar                   |
| Sheets              | `.xlsx`                | Native spreadsheet tools and Harness sidebar                |
| Slides              | `.pptx`                | Native presentation tools and Harness sidebar               |
| PDF, Markdown, HTML | `.pdf`, `.md`, `.html` | Local web editors; feature coverage is still being verified |

## Demo

Press play below, or use each **Play directly** link to open a video player in a new tab. GitHub's `.mp4` file pages are for viewing or downloading the file, not for inline playback.

### Excel — AI chart (21 seconds)

[▶ Play directly](https://github.com/user-attachments/assets/7507bada-e64f-40e8-9817-b17a019c0b82)

https://github.com/user-attachments/assets/7507bada-e64f-40e8-9817-b17a019c0b82

### Docs — edit and save (10 seconds)

[▶ Play directly](https://github.com/user-attachments/assets/aea696c7-7c1e-4d7e-afdd-811dd11d9a5d)

https://github.com/user-attachments/assets/aea696c7-7c1e-4d7e-afdd-811dd11d9a5d

### Slides — edit and save (8 seconds)

[▶ Play directly](https://github.com/user-attachments/assets/a3a3c93b-2f73-44b9-be67-8f40109d6c3b)

https://github.com/user-attachments/assets/a3a3c93b-2f73-44b9-be67-8f40109d6c3b

The Excel video shows a real AI session: select `A4:B10`, request a column chart at `D4`, approve the writes, and save. AI waiting periods are shortened and marked on screen. The Docs and Slides videos show real **manual editor** changes and saved files; they do not portray those edits as AI-generated. All three clips use fictional samples, have English on-screen captions, and contain no user files or API credentials.

## Quick start

Use Node.js **24 LTS** (the verified version), npm **10+**, and Rust/Cargo for the XLSX engine. `package.json` allows Node.js 22.12 or newer, but the complete integration has not been verified on every newer major version. The first build may take a while.

```bash
git clone https://github.com/het2333/Offira.git
cd Offira
npm ci
npm run build:web
npm run start:web -- "/absolute/path/to/example.xlsx"
```

You can open several existing files at startup:

```bash
npm run start:web -- "/absolute/path/to/document.docx" "/absolute/path/to/workbook.xlsx" "/absolute/path/to/presentation.pptx"
```

Open the `bootstrapUrl` printed in the terminal. In the current local-access mode, it is a `http://127.0.0.1:<port>/` address; the port may change between runs. Do not expose the service to the public internet, and do not open `apps/web/index.html` directly with `file://`. At least one existing file path is required. Supported startup extensions are `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.md`, and `.html`.

In **Settings → AI Models**, configure a key for DeepSeek, OpenAI, Anthropic, OpenRouter, Gemini, or another supported provider, then select a model in the editor chat panel. Existing API keys in a legacy `providers.env` file are imported into the local Harness credential store on the next start; the original file is not deleted automatically. Never commit real API keys.

## How it works

```text
Browser: Offira home screen and file editors
             │ HTTP / WebSocket (local loopback only)
             ▼
Local Host: file access, session binding, approvals, persistence, recovery
             │ private process communication
             ▼
DeepSeek Harness: agent runtime, model providers, native Office tools
```

The editors expose semantic operation DSLs to native Harness tools. Tool results are summarized for the agent instead of exposing low-level engine objects. This provides practical editing coverage without maintaining hundreds of fragile one-to-one API wrappers.

Repository layout:

- `apps/web` — local web shell.
- `apps/local-host` — loopback HTTP/WebSocket service and file-access boundary.
- `packages/nexusdesk-runtime-host` — Harness runtime and Office tool integration.
- `packages/nexusdesk-shell-ui` — shared home screen, settings, and file tabs.
- `apps/docs`, `apps/sheets`, `apps/slides` — the three primary Office editors.

## Project status

Current work focuses on reliable local editing and AI workflows. Desktop installers, cloud sync, real-time collaboration, and one-to-one tools for every low-level editor API are **not** delivered features of this preview.

Validation commands:

```bash
npm run typecheck
npm test
npm run test:e2e:local-web
```

Some full-suite tests depend on local fonts, LibreOffice, native build tools, or DNS behavior. Check individual failures rather than treating an environment-dependent result as proof that every editing workflow passed or failed. See the [current verification notes (Chinese)](docs/harness-office-panel-verification.md).
