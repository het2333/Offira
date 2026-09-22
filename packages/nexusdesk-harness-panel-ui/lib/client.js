window.__ModuleLoader__.load({
  id: "@nexusdesk/harness-office-panel-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

    // src/client.tsx
    var client_exports = {};
    __export(client_exports, {
      OFFICE_PANEL_CONTENT_SLOT: () => OFFICE_PANEL_CONTENT_SLOT,
      OFFICE_PANEL_FALLBACK_PRIORITY: () => OFFICE_PANEL_FALLBACK_PRIORITY,
      OFFICE_PANEL_PRIMARY_PRIORITY: () => OFFICE_PANEL_PRIMARY_PRIORITY,
      OfficeConversationContent: () => OfficeConversationContent,
      apply: () => apply,
      inject: () => inject
    });
    module.exports = __toCommonJS(client_exports);
    var import_react = require("react");

    // src/binding.ts
    var bindingKey = Symbol.for("@nexusdesk/harness-office-panel-ui/binding");
    function bindingGlobal() {
      return globalThis;
    }
    function validateBinding(binding) {
      if (binding.sessionId.trim() === "") {
        throw new Error("Office panel binding sessionId must be a non-empty string");
      }
      if (typeof binding.captureSubmission !== "function") {
        throw new Error("Office panel binding captureSubmission must be a function");
      }
    }
    function requireOfficePanelBinding() {
      const binding = bindingGlobal()[bindingKey]?.binding;
      if (binding === void 0) {
        throw new Error(
          "Office panel binding must be installed by the authenticated carrier before native boot"
        );
      }
      validateBinding(binding);
      return binding;
    }

    // src/pending-submissions.ts
    function asError(value) {
      return value instanceof Error ? value : new Error(String(value));
    }
    var OfficePanelCaptureFailure = class {
      value = null;
      listeners = /* @__PURE__ */ new Set();
      getSnapshot = () => this.value;
      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };
      fail(error) {
        if (this.value !== null) return;
        this.value = asError(error);
        for (const listener of this.listeners) listener();
      }
    };
    function startPendingSubmissionCapture(options) {
      const seen = /* @__PURE__ */ new Set();
      let disposed = false;
      let unsubscribe = () => {
      };
      const captureCurrent = () => {
        const snapshot = options.session.getSnapshot();
        if (snapshot.sessionId !== options.expectedSessionId) {
          throw new Error(
            `Office panel expected Session "${options.expectedSessionId}" but observed "${snapshot.sessionId}"`
          );
        }
        for (const submission of snapshot.pendingSubmissions) {
          const requestId = submission.requestId;
          if (seen.has(requestId)) continue;
          options.captureSubmission(requestId);
          seen.add(requestId);
        }
      };
      const fail = (error) => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        if (options.onError === void 0) throw asError(error);
        options.onError(asError(error));
      };
      unsubscribe = options.session.subscribe(() => {
        try {
          captureCurrent();
        } catch (error) {
          fail(error);
        }
      });
      try {
        captureCurrent();
      } catch (error) {
        unsubscribe();
        disposed = true;
        throw error;
      }
      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          unsubscribe();
        }
      };
    }

    // src/client.tsx
    var import_jsx_runtime = require("react/jsx-runtime");
    var OFFICE_PANEL_CONTENT_SLOT = "office.content";
    var OFFICE_PANEL_PRIMARY_PRIORITY = -200;
    var OFFICE_PANEL_FALLBACK_PRIORITY = -100;
    function OfficeFailureScreen() {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "div",
        {
          "data-nexusdesk-office-panel": "failed",
          role: "alert",
          style: {
            alignItems: "center",
            boxSizing: "border-box",
            display: "flex",
            justifyContent: "center",
            minHeight: "100%",
            padding: "24px",
            textAlign: "center"
          },
          children: "\u6587\u6863\u52A9\u624B\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u3002\u8BF7\u91CD\u65B0\u6253\u5F00\u9762\u677F\uFF1B\u82E5\u521A\u624D\u63D0\u4EA4\u8FC7\u4FEE\u6539\uFF0C\u8BF7\u5148\u68C0\u67E5\u6587\u4EF6\u518D\u7EE7\u7EED\u3002"
        }
      );
    }
    var OfficePanelErrorBoundary = class extends import_react.Component {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(_error, _info) {
      }
      render() {
        return this.state.failed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OfficeFailureScreen, {}) : this.props.children;
      }
    };
    function OfficePanelBody(props) {
      const failure = (0, import_react.useSyncExternalStore)(
        props.failure.subscribe,
        props.failure.getSnapshot,
        props.failure.getSnapshot
      );
      if (failure !== null) throw failure;
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "div",
        {
          "data-nexusdesk-office-panel": "ready",
          style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, width: "100%", overflow: "hidden" },
          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(props.SessionProvider, { empty: OfficeFailureScreen, session: props.reference, children: props.renderSlot(
            OFFICE_PANEL_CONTENT_SLOT,
            {},
            {
              fallback: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OfficeFailureScreen, {})
            }
          ) })
        }
      );
    }
    function createOfficeRoot(ownership) {
      return function OfficePanelRoot(props) {
        (0, import_react.useEffect)(() => () => ownership.dispose(), []);
        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OfficePanelErrorBoundary, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OfficePanelBody, { ...props, failure: ownership.failure, reference: ownership.reference }) });
      };
    }
    function OfficeFallbackRoot() {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OfficeFailureScreen, {});
    }
    function OfficeConversationContent(props) {
      return props.renderFactorySlot(
        "conversation.content",
        {
          variant: "embedded",
          phase: "active",
          hero: false
        },
        {
          fallback: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OfficeFailureScreen, {})
        }
      );
    }
    function assertMatchingSession(expectedSessionId, reference, binding) {
      const observed = [reference.sessionId, binding.sessionId, binding.session.getSnapshot().sessionId];
      const mismatch = observed.find((sessionId) => sessionId !== expectedSessionId);
      if (mismatch !== void 0) {
        throw new Error(
          `Office panel expected Session "${expectedSessionId}" but observed "${mismatch}"`
        );
      }
    }
    var inject = ["slots", "sessions", "uiSession", "uiConversation", "conversation"];
    async function apply(ctx) {
      const carrier = requireOfficePanelBinding();
      await ctx.sessions.refresh();
      const reference = ctx.sessions.retain(carrier.sessionId, {
        source: "officePanel"
      });
      let released = false;
      let capture;
      const release = () => {
        if (released) return;
        released = true;
        capture?.dispose();
        reference.release();
      };
      try {
        const binding = await reference.ready;
        assertMatchingSession(carrier.sessionId, reference, binding);
        if (carrier.subscribeDraftRequests) {
          ctx.effect(() => carrier.subscribeDraftRequests((text) => {
            const input = ctx.conversation.input.for(binding.ctx);
            const draft = input.state.getSnapshot().draft;
            input.setDraft(draft ? `${draft}
    ${text}` : text);
            input.focus();
          }), "office-panel-ui: editor toolbar draft requests");
        }
        if (carrier.connection) {
          const connection = carrier.connection;
          ctx.effect(() => {
            const update = () => {
              const ready = connection.getSnapshot();
              ctx.conversation.blocks.set(
                carrier.sessionId,
                ready ? void 0 : { reason: "\u672C\u5730\u8FDE\u63A5\u6B63\u5728\u6062\u590D\uFF0C\u8349\u7A3F\u5DF2\u4FDD\u7559\uFF0C\u8BF7\u7A0D\u540E\u53D1\u9001\u3002" }
              );
            };
            const off = connection.subscribe(update);
            update();
            return () => {
              off();
              ctx.conversation.blocks.set(carrier.sessionId, void 0);
            };
          }, "office-panel-ui: connection composer gate");
        }
        const failure = new OfficePanelCaptureFailure();
        capture = startPendingSubmissionCapture({
          expectedSessionId: carrier.sessionId,
          session: binding.session,
          captureSubmission: (requestId) => carrier.captureSubmission(requestId),
          onError: (error) => failure.fail(error)
        });
        const ownership = { reference, failure, dispose: release };
        ctx.effect(() => release, "office-panel-ui: Session reference and submission capture");
        ctx.slots.register(
          {
            name: "root",
            priority: OFFICE_PANEL_FALLBACK_PRIORITY
          },
          OfficeFallbackRoot
        );
        ctx.slots.register(
          {
            name: "root",
            priority: OFFICE_PANEL_PRIMARY_PRIORITY,
            children: {
              [OFFICE_PANEL_CONTENT_SLOT]: { kind: "single", scope: "session-maybe" }
            }
          },
          createOfficeRoot(ownership)
        );
        ctx.slots.register({ name: OFFICE_PANEL_CONTENT_SLOT }, OfficeConversationContent);
      } catch (error) {
        release();
        throw error;
      }
    }

    return module.exports;
  }
});
