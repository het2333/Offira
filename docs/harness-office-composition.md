# Harness Office client composition

Verified against installed `@deepseek-ai/*` `0.1.6-alpha.2` artifacts on 2026-09-21. This document describes the browser composition boundary only. It does not claim that the restricted Host profile or authenticated carrier has completed a real boot.

## Public package and browser row

The Host package name and Client ModuleLoader row are both `@nexusdesk/harness-office-panel-ui`. The runtime profile Loader row may use the distinct profile identity `office-panel-ui`, but its `name` must resolve this workspace package so `dsh-client-modules` can read the package manifest and built `./client` artifact.

The package exposes:

- `.`: an intentionally empty Host `apply()` used for Loader discovery.
- `./binding`: the carrier-facing `OfficePanelBinding` and `installOfficePanelBinding()` function.
- `./client`: declarations plus a browser artifact that calls `window.__ModuleLoader__.load({ id, factory })`.

The Client bundle resolves `react` and `react/jsx-runtime` from the shell module loader. Cordis, Session, and Slot imports in the source are type-only, so the bundle does not create second React, Cordis, Session, or Slot identities.

## Carrier binding and ordering

The authenticated same-origin carrier must install this capability before starting AppWebEntry:

```ts
export interface OfficePanelBinding {
  readonly sessionId: string
  captureSubmission(requestId: string): void
}
```

`captureSubmission` is a carrier closure over the authorized document/editor binding. It must clone and schema-validate the current editor revision and selection, then register that envelope for the exact native request ID before prompt admission. It must not read the active Harness Session selection or route the send through the legacy Agent loop.

The Client plugin retains `sessionId` with source `officePanel`, awaits `SessionReference.ready`, verifies the reference, binding, and Session snapshot identities, and subscribes directly to the bound Session's public `pendingSubmissions`. Each request ID is captured once. The Session implementation publishes the echo in a microtask before the official composer awaits `nextPaint()`. Carrier admission must reject a prompt without its matching captured envelope.

The carrier must dispose in this order:

1. Hide/unmount the renderer and stop its marker observer.
2. Dispose the Client boot/plugin graph, which removes the capture listener and releases the Session reference.
3. Dispose the binding installation and authenticated transport.

Releasing the Client reference only ends local UI ownership. It does not delete the durable Host Session.

## Official rendering path

The primary Office root is registered in public `root` at priority `-200`. It declares only `office.content` (`single`, `session-maybe`) and renders that child inside the public `SessionProvider` with the retained `SessionReference`.

`office.content` invokes the installed public factory exactly as follows:

```ts
renderFactorySlot('conversation.content', {
  variant: 'embedded',
  phase: 'active',
  hero: false,
})
```

The factory remains owned by official `dsh-client-ui-conversation`; official `dsh-client-ui-chat` contributes the conversation view. This composition does not import a private React component, copy transcript rendering, render `main`, or render the Session header, workspace hero, sidebar, rightbar, or generic shell.

## Fail-closed presentation and carrier guard

An independent failure root is registered at priority `-100`, ahead of the stock AppFrame at priority `0`. If the primary root abdicates after a render error, public SlotCore election selects the Office failure root rather than AppFrame. An error boundary also contains factory/child and capture failures without depending on the failed business component.

The primary root carries `[data-nexusdesk-office-panel="ready"]`; every contained or independent failure surface carries `[data-nexusdesk-office-panel="failed"]`. After AppWebEntry reports completion, the carrier must require one of these markers before revealing the container. It must keep observing the mounted container and immediately hide it if the marker disappears, including custom-row unload. Missing custom row, missing factory, boot rejection, or plugin unload are failures; none may reveal the underlying generic workbench. Shipped Office composition must disable HMR unless row unload/remount has its own proven fail-closed test.

These presentation guards are not authorization. Every asset, graph, bundle, RPC, stream, Session, document, and Origin decision remains enforced by the authenticated Host carrier even when no navigation or generic UI is visible.

## Profile roster for the first real boot

The conservative inspected roster is `modules`, `connection`, existing `typert`, existing `typert-gateway`, `api-remotes`, `file-upload`, `session-controller`, `workspace-controller`, `locale`, `ui-renderer`, `ui-settings`, `ui-conversation`, `ui-layout`, `ui-session`, `ui-theme`, `ui-workspace`, `ui-input-trigger`, `ui-sidebar-right`, `resources`, `ui-chat`, `ui-commands`, `ui-model-selection`, `ui-user-questions`, `ui-approval`, plus `office-panel-ui`.

`ui-sidebar` is not needed by a verified business-service consumer in this composition and is the first removal candidate, but the roster is not minimal until a real activation audit proves every retained row active. The restricted Host still needs safe namespaces for `remote.subagents`, `remote.directoryPicker`, and `remote.settings` because official Controller/UI plugins inject them; namespace availability must not grant delegation, arbitrary directory access, credentials, or unrestricted settings methods.

Do not add shell, terminal, arbitrary workspace files, browser, plugin manager, subagent UI, trajectory, or the full `dsh-web-app` profile merely to satisfy boot.

## Known integration boundary

`@deepseek-ai/dsh-client-web` is not installed in this worktree. Installed `dsh-web-frontend` is a prebuilt auto-boot asset and exports no AppWebEntry symbol. A custom carrier kernel must add and validate same-version public `@deepseek-ai/dsh-client-web@0.1.6-alpha.2`, or deliberately use the official prebuilt frontend path. It must not import the adjacent Harness source tree.

The package build required the public `@deepseek-ai/dsh-client-store@0.1.6-alpha.2` type dependency. No installed public type mismatch was found for `SessionReference`, `SessionProvider`, `pendingSubmissions`, `SlotCore`, or `conversation.content`.
