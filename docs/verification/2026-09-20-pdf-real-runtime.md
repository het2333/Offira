# PDF Local Web production-runtime verification

This supplements the fake-runtime UI tests. It is not a claim that all replay release gates pass.

## Real runtime path

`e2e/local-web-pdf-real-runtime.spec.ts` launches the production
`packages/nexusdesk-runtime-host/lib/index.mjs` child with its actual base profile.
Only the upstream model responses come from a controlled localhost HTTP provider;
no API credentials or external model service are required. The production agent
loop, curated PDF tool registration/execution, `proposalFrom`, operation IDs,
snapshot hashes, approvals, browser adapter, and Local Host PDF writes are real.

The passing case verifies the exact 19-tool PDF catalog, two visible approval
cards, matching proposal/apply operation IDs and plan hashes, no disk mutation
before save approval, successful tool-result envelopes, exactly one saved
annotation, and persistence after browser reload.

This test exposed and fixed three previously masked runtime defects:

- `tools.schemas()` reads the global registry unless passed the Agent scope.
- `agents.create` needs the selected default provider/model explicitly supplied
  from the profile's `agentDefaultModel.currentSelection()` service.
- `propose_save`, like `propose_ops`, must not reserve/commit the mutation journal;
  the subsequent approved save reuses that proposal's operation ID.

## Conservative inline image contract

Until a binary blob-upload contract exists, Local Web PDF supports at most
524,288 base64 characters per image (384 KiB decoded), and 1,500,000 UTF-8 bytes
for the complete save envelope. This stays below the Host's 2,000,000-byte JSON
transport boundary; support for larger images is deliberately not claimed.

The same typed `PDF_PAYLOAD_TOO_LARGE` check runs before runtime proposals,
after renderer image replacement/baking, against the predicted aggregate pending
save before proposal/apply, before browser HTTP dispatch, and inside the Host.
Rejected payloads do not advance the document revision or alter disk bytes.
Tests cover exact image boundaries, aggregate images, UTF-8 size, replacement,
baked output, no approval/HTTP dispatch on rejection, and existing real PNG/JPEG
saves.

## Commands and remaining release gates

```sh
npm run test -w @nexusdesk/protocol
npm run test -w @nexusdesk/runtime-host
npm run test -w @nexusdesk/local-host
npm run test -w @genoffice/pdf
npm run typecheck -w @genoffice/pdf
npm run typecheck -w @nexusdesk/runtime-host
npm run typecheck -w @nexusdesk/local-host
npm run typecheck -w @nexusdesk/protocol
npm run typecheck -w @nexusdesk/office-host
npm run build -w @nexusdesk/runtime-host
npm run smoke -w @nexusdesk/runtime-host
npm run build:web-renderer -w @genoffice/pdf
npx playwright test e2e/local-web-pdf-agent.spec.ts e2e/local-web-pdf-real-runtime.spec.ts --project=chromium
git diff --check
```

Unit suites pass: protocol 9, runtime 33, Local Host 77, PDF 806. The listed
typechecks, runtime build/smoke, and PDF renderer build pass.

Two browser gates remain intentionally unweakened before mainline replay work
is integrated:

- The original fake-runtime reload retry still requests fresh approval rather
  than returning the accepted operation without another prompt.
- The new real-runtime transport-replay case redelivers the original approved
  `editor:request` bytes. The browser coalesces execution, but the Host rejects the
  duplicate `editor:result` and disconnects the client, preventing completion.

The non-replay production-runtime case and the existing manual/approved page
rewrite UI case pass. The fake runtime is no longer the sole execution evidence.
