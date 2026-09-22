import type { ClientId, DocumentId, Revision } from '@nexusdesk/protocol'

import type { NexusClient } from './client'
import { createHarnessTransport } from './harness-transport'

export interface HarnessPanelSnapshot {
  readonly revision: Revision
  readonly selection: unknown
}

export interface HarnessPanelCapability {
  readonly rpc: ReturnType<typeof createHarnessTransport>['rpc']
  readonly binding: {
    readonly sessionId: string
    captureSubmission(requestId: string): void
  }
  onReady(): void
  onError(): void
}

export interface MountHarnessPanelOptions {
  readonly container: HTMLElement
  readonly client: NexusClient
  readonly clientId: ClientId
  readonly documentId: DocumentId
  readonly captureSnapshot: () => HarnessPanelSnapshot
  readonly subscribeDraftRequests?: (listener: (text: string) => void) => () => void
  readonly document?: Pick<Document, 'createElement'>
  readonly readyTimeoutMs?: number
  readonly signal?: AbortSignal
}

type OfficeFrame = HTMLIFrameElement & {
  __NEXUSD_OFFICE__?: HarnessPanelCapability
}

const DEFAULT_READY_TIMEOUT_MS = 15_000
const FAILURE_MESSAGE =
  '文档助手未能连接。请重新打开当前文档面板；不要重复提交未核实的修改。'
const TIMEOUT_MESSAGE =
  '文档助手连接超时。请重新打开当前文档面板；不要重复提交未核实的修改。'

function showFailure(container: HTMLElement, owner: Pick<Document, 'createElement'>, message: string) {
  const status = owner.createElement('div')
  status.className = 'nexusdesk-harness-panel-error'
  status.setAttribute('role', 'alert')
  status.textContent = message
  container.replaceChildren(status)
}

/**
 * Mount the official Harness frontend over the editor's existing authenticated
 * NexusClient. The capability is installed before the iframe can execute.
 */
export async function mountHarnessPanel(
  options: MountHarnessPanelOptions,
): Promise<() => void> {
  const owner = options.document ?? document
  const transport = createHarnessTransport(options.client, options.documentId)
  let iframe: OfficeFrame | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let rejectAbort: (() => void) | undefined

  const abortError = () => new DOMException('文档助手挂载已取消。', 'AbortError')

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    options.signal?.removeEventListener('abort', abort)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    iframe?.remove()
    transport.dispose()
  }
  const abort = (): void => {
    dispose()
    rejectAbort?.()
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()

  let sessionId: string
  try {
    sessionId = await transport.bind()
  } catch (error) {
    dispose()
    if (options.signal?.aborted) throw abortError()
    showFailure(options.container, owner, FAILURE_MESSAGE)
    throw new Error(FAILURE_MESSAGE, { cause: error })
  }

  if (disposed || options.signal?.aborted) throw abortError()
  iframe = owner.createElement('iframe') as OfficeFrame
  iframe.className = 'nexusdesk-harness-panel-frame'
  iframe.title = '文档助手'
  iframe.style.width = '100%'
  iframe.style.height = '100%'
  iframe.style.border = '0'
  iframe.style.display = 'block'
  const search = new URLSearchParams({
    clientId: options.clientId,
    documentId: options.documentId,
  })
  iframe.setAttribute('src', `/harness/index.html?${search.toString()}`)

  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let readinessSettled = false
  let failed = false
  rejectAbort = () => {
    if (readinessSettled) return
    readinessSettled = true
    rejectReady(abortError())
  }
  const fail = (message: string): void => {
    if (failed || disposed) return
    failed = true
    const rejectMount = !readinessSettled
    readinessSettled = true
    dispose()
    showFailure(options.container, owner, message)
    if (rejectMount) rejectReady(new Error(message))
  }

  iframe.__NEXUSD_OFFICE__ = {
    rpc: transport.rpc,
    binding: {
      sessionId,
      captureSubmission(requestId) {
        const snapshot = structuredClone(options.captureSnapshot())
        transport.captureSubmission(requestId, snapshot)
      },
    },
    onReady() {
      if (readinessSettled || disposed) return
      readinessSettled = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      resolveReady()
    },
    onError() {
      fail(FAILURE_MESSAGE)
    },
  }

  timer = setTimeout(
    () => fail(TIMEOUT_MESSAGE),
    options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
  )
  options.container.appendChild(iframe)
  await ready
  return dispose
}
