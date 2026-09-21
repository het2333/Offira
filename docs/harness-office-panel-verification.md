# Harness Office panel — implementation checkpoint

Date: 2026-09-21. Branch: `feat/nexusdesk-local-web`.

## Release status

**Not enabled by default; browser acceptance is still outstanding.**
The current integration uses installed Harness `0.1.6-alpha.2`, its actual
conversation factory, SessionProvider, model UI, approval UI and question UI.
It does not imitate the Harness interface or start a second general-purpose
Harness server. Sheets opts in through its editor URL's `nativeHarness=1`.
Docs and Slides rollout remains gated on successful Sheets browser acceptance.

## Implemented

- Sheets reads expand bounded ranges into cells, await hydration and reject
  conflicting worksheet identities instead of reporting false empty ranges.
- Host/document bindings persist official Session IDs. A cross-process lock
  protects mapping updates, including normal lock handoff and dead owners.
- Official resources and RPC use the existing authenticated Local Host. The
  gateway scopes history, prompt, model and event access to the bound Session.
  Provider credentials remain in the Host; browser payloads cannot select cwd.
- Submission context captures a numeric revision and validated selection;
  the Host checks the revision again before admitting the original prompt.
  Request identities cannot be reused to replay a prepared submission.
- Shared mount installs the authenticated capability before iframe boot.
  Missing or failed native UI stays fail-closed rather than exposing a generic
  workbench. Connection errors explain recovery in Chinese.
- Office approval cards answer the existing exact parent approval ID. They do
  not bypass the planHash/operationId ledger. Duplicate/expired/foreign-token
  answers are rejected. Stream loss revokes pending answers. Browser notification
  failures do not interrupt expiration or runtime-exit cleanup.
- Native Stop invalidates both pending and already-granted-but-unconsumed Host
  approvals before forwarding official cancellation. A foreign Session cancel
  cannot revoke the current document's approval.
- The runtime bridge checks tool cancellation before requests and approval,
  and after read/proposal/approval responses. Late proposals cannot advance to
  a new approval after cancellation. Already-dispatched authorized mutations
  still return their verified or unknown receipt rather than implying no write.
- Generic native approvals delegate to the official waterfall; legacy traffic
  retains its existing IPC path. `ask_user_question` is scoped to native Sessions.

## Verification recorded

- Actual restricted Host graph and real native model-catalog smoke passed.
- Runtime-host final full suite: **112/112 passed**, one worker.
- Real HTTP/WebSocket integration passed: unauthenticated HTML rejected;
  authenticated but unbound HTML rejected; bound official HTML/plugin bundle
  served; real catalog callable; foreign Session request rejected.
- Local Host full suite: **227 passed / 3 failed** (230 tests), one worker.
  The failures were 5-second timeouts in `slides-document-driver.test.ts`:
  `opens, edits, and saves one real PPTX session in place`,
  `validates and saves an Agent transaction result in the isolated service`, and
  `translates an AI edit script through the isolated transaction service`.
  This is not a green whole-suite result.
  A separate rerun of that file with `--testTimeout=30000` passed all 6 tests;
  the default test timeout/configuration was not changed.
- Final native carrier + AgentRouter + real HTTP/WebSocket integration rerun:
  **41/41 passed**, including pending/granted cancellation regressions.
- Native transport and shared mount: 15 passed. Official UI package: 14 passed.
  New protocol frames: 3 passed.
- Local Host, web-client and runtime-host typechecks passed. Scoped production
  lint and runtime build passed. Sheets Web renderer build passed.
- Sheets typecheck still reports the preexisting missing `jsdom` declaration
  in `tests/browser-host-api.test.ts:773`; no unrelated dependency change made.

## Browser gate and remaining work

The isolated test service uses a generated workbook containing 1, 2, 3 and
separate temporary working-copy/runtime storage. The user's existing service
and open documents have not been refreshed or altered.

At `http://127.0.0.1:51027/`, the service returned HTTP 401 as expected before
authentication. Browser automation returned `net::ERR_BLOCKED_BY_CLIENT` for
both the root and authenticated bootstrap navigation in the in-app browser;
Chrome navigation was also blocked. No browser security protection was disabled.
Consequently **actual native UI activation, model selection, sum=6, questions,
approval/write/save/reopen and refresh recovery have not passed browser QA**.

The cancel-before-approval/after-grant regression discovered in independent
review is fixed and covered by the final 41-test rerun. A subsequent review
also found that a proposal returning after cancellation could create a new
approval; bridge abort checks now cover that path, with 13 focused identity
tests including preservation of dispatched mutation outcomes. Further work:

1. Resolve browser navigation and exercise the actual official frontend.
2. Verify Chinese DSL-derived approval descriptions against the actual plan;
   raw tool IDs/JSON must not be the main explanation.
3. Verify native questions (including custom answers and cancellation), a
   read-only sum, exact once-only writes, durable save and reconnect behavior.
4. Reuse the verified mount in Docs and Slides; enable by default only after QA.

This checkpoint is not a claim of complete native editing-tool coverage.
