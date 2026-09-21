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
function installOfficePanelBinding(binding) {
  validateBinding(binding);
  const target = bindingGlobal();
  if (target[bindingKey] !== void 0) {
    throw new Error("Office panel binding is already installed");
  }
  const token = Symbol("office-panel-binding-installation");
  target[bindingKey] = { binding, token };
  return () => {
    if (target[bindingKey]?.token === token) delete target[bindingKey];
  };
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
export {
  installOfficePanelBinding,
  requireOfficePanelBinding
};
