/** Authenticated carrier capability consumed by the Office-only Client plugin. */
export interface OfficePanelBinding {
  readonly sessionId: string
  captureSubmission(requestId: string): void
  readonly connection?: { getSnapshot(): boolean; subscribe(listener: () => void): () => void }
  subscribeDraftRequests?(listener: (text: string) => void): () => void
}

interface BindingHolder {
  readonly binding: OfficePanelBinding
  readonly token: symbol
}

const bindingKey = Symbol.for('@nexusdesk/harness-office-panel-ui/binding')

type BindingGlobal = typeof globalThis & {
  [bindingKey]?: BindingHolder
}

function bindingGlobal(): BindingGlobal {
  return globalThis as BindingGlobal
}

function validateBinding(binding: OfficePanelBinding): void {
  if (binding.sessionId.trim() === '') {
    throw new Error('Office panel binding sessionId must be a non-empty string')
  }
  if (typeof binding.captureSubmission !== 'function') {
    throw new Error('Office panel binding captureSubmission must be a function')
  }
}

/**
 * Install the browser capability before AppWebEntry starts the native Client graph.
 * The returned disposer can only clear the exact installation it created.
 */
export function installOfficePanelBinding(binding: OfficePanelBinding): () => void {
  validateBinding(binding)
  const target = bindingGlobal()
  if (target[bindingKey] !== undefined) {
    throw new Error('Office panel binding is already installed')
  }
  const token = Symbol('office-panel-binding-installation')
  target[bindingKey] = { binding, token }
  return () => {
    if (target[bindingKey]?.token === token) delete target[bindingKey]
  }
}

/** Resolve the authenticated capability or reject Client activation. */
export function requireOfficePanelBinding(): OfficePanelBinding {
  const binding = bindingGlobal()[bindingKey]?.binding
  if (binding === undefined) {
    throw new Error(
      'Office panel binding must be installed by the authenticated carrier before native boot',
    )
  }
  validateBinding(binding)
  return binding
}
