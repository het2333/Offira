import { defaultAiSettings } from '@genoffice/ai-provider/browser'
import { DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import type { AgentApi } from '@nexusdesk/web-client'
import { createNexusClient, type NexusClient } from '@nexusdesk/web-client'

import type { MarkdownApi, SaveMarkdownResult, UiTheme } from '../shared/ipc'
import { createMarkdownBrowserAgentBridge, type MarkdownBrowserAgentBridge } from './agent/browser-agent-api'

type MarkdownLanguage = Awaited<ReturnType<MarkdownApi['getLanguage']>>

export interface MarkdownBrowserBootstrap {
  documentId: string
  title: string
  revision: number
  websocketUrl: string
  language: MarkdownLanguage
  theme: UiTheme
  contentUrl: string
}

export interface MarkdownDocumentWriteResult {
  documentId: string
  title: string
  editorType: 'markdown'
  revision: number
}

export interface MarkdownBrowserTransport {
  readContent(): Promise<Uint8Array>
  writeContent(bytes: Uint8Array, expectedRevision: number): Promise<MarkdownDocumentWriteResult>
}

export interface MarkdownBrowserHostHandle {
  readonly document: { readonly documentId: string; readonly title: string; revision: number }
  readonly settings: Pick<MarkdownBrowserBootstrap, 'language' | 'theme'>
  readonly api: MarkdownApi
  readonly bridge: MarkdownBrowserAgentBridge
  updateRevision(revision: number): void
  dispose(): void
}

export interface MarkdownBrowserHostTarget {
  markdownApi?: MarkdownApi
  agentApi?: AgentApi
  nexusdeskMarkdownHost?: MarkdownBrowserHostHandle
}

export interface InstallMarkdownBrowserHostOptions {
  target?: MarkdownBrowserHostTarget
  transport?: MarkdownBrowserTransport
  client?: NexusClient
}

export class MarkdownWebUnavailableError extends Error {
  readonly code = 'UNAVAILABLE_IN_WEB' as const

  constructor(capability: string) {
    super(`${capability} is unavailable in Web Markdown`)
    this.name = 'MarkdownWebUnavailableError'
  }
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new MarkdownWebUnavailableError(capability))
}

function noListener(): () => void {
  return () => undefined
}

function virtualPath(documentId: string): string {
  return `nexusdesk://${documentId}`
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function hostError(response: Response): Promise<Error> {
  let message = `Local Host request failed with HTTP ${String(response.status)}`
  try {
    const value = (await response.json()) as { message?: unknown; error?: unknown }
    if (typeof value.message === 'string') message = value.message
    else if (typeof value.error === 'string') message = value.error
  } catch {
    // Keep the HTTP status as the browser-safe fallback.
  }
  return new Error(message)
}

export async function loadMarkdownBrowserBootstrap(
  documentId: string,
  fetchBootstrap: typeof fetch = globalThis.fetch,
): Promise<MarkdownBrowserBootstrap> {
  const response = await fetchBootstrap(
    `/api/documents/${encodeURIComponent(documentId)}/bootstrap`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) throw new Error(`Document bootstrap failed with HTTP ${String(response.status)}`)
  const value = (await response.json()) as Partial<MarkdownBrowserBootstrap>
  if (
    typeof value.documentId !== 'string' ||
    typeof value.title !== 'string' ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.websocketUrl !== 'string' ||
    typeof value.language !== 'string' ||
    typeof value.theme !== 'string' ||
    typeof value.contentUrl !== 'string'
  ) {
    throw new Error('Local Host returned an invalid Markdown bootstrap')
  }
  return value as MarkdownBrowserBootstrap
}

export function createHttpMarkdownBrowserTransport(
  bootstrap: MarkdownBrowserBootstrap,
  fetchImpl: typeof fetch = globalThis.fetch,
): MarkdownBrowserTransport {
  return {
    async readContent() {
      const response = await fetchImpl(bootstrap.contentUrl, { credentials: 'same-origin' })
      if (!response.ok) throw await hostError(response)
      return new Uint8Array(await response.arrayBuffer())
    },
    async writeContent(bytes, expectedRevision) {
      const response = await fetchImpl(bootstrap.contentUrl, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream', 'If-Match': String(expectedRevision) },
        body: toArrayBuffer(bytes),
      })
      if (!response.ok) throw await hostError(response)
      const value = (await response.json()) as Partial<MarkdownDocumentWriteResult>
      if (
        value.documentId !== bootstrap.documentId ||
        value.editorType !== 'markdown' ||
        typeof value.title !== 'string' ||
        !Number.isSafeInteger(value.revision) ||
        (value.revision ?? 0) <= expectedRevision
      ) {
        throw new Error('Local Host returned an invalid Markdown write result')
      }
      return value as MarkdownDocumentWriteResult
    },
  }
}

/** Build the preload-shaped surface consumed by the unmodified Markdown renderer. */
export function createMarkdownBrowserApi(
  handle: Pick<MarkdownBrowserHostHandle, 'document' | 'settings' | 'updateRevision'>,
  transport: MarkdownBrowserTransport,
): MarkdownApi {
  let pending = true
  let prefs: AiPanelPrefs = DEFAULT_AI_PANEL_PREFS
  const preferenceListeners = new Set<(next: AiPanelPrefs) => void>()
  const path = virtualPath(handle.document.documentId)
  const implemented: Partial<MarkdownApi> = {
    async consumePending() {
      if (!pending) return null
      pending = false
      return path
    },
    consumeHeadlessExport: async () => null,
    headlessExportDone: () => undefined,
    async readFile(candidate) {
      if (candidate !== path) throw new MarkdownWebUnavailableError('opening an arbitrary filesystem path')
      return new TextDecoder('utf-8', { fatal: true }).decode(await transport.readContent())
    },
    async save(request): Promise<SaveMarkdownResult> {
      if (request.mode !== 'save') return { ok: false, error: 'Save As is unavailable in Web Markdown.' }
      try {
        const result = await transport.writeContent(
          new TextEncoder().encode(request.text),
          handle.document.revision,
        )
        handle.updateRevision(result.revision)
        return { ok: true, path, writtenText: request.text }
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    setDirty: () => undefined,
    onSaveRequest: noListener,
    sendSaveRequestAck: () => undefined,
    onReadTextRequest: noListener,
    sendReadTextResult: () => undefined,
    onCloseSaveRequest: noListener,
    sendCloseSaveResult: () => undefined,
    onFileRenamed: noListener,
    pickImage: () => unavailable('the native image picker'),
    saveImage: () => unavailable('saving local image assets'),
    readImage: async () => null,
    saveImageAs: () => unavailable('the native image save dialog'),
    onViewImage: noListener,
    onExportRequest: noListener,
    onPrintRequest: noListener,
    exportDocx: () => unavailable('native document export'),
    exportPdf: () => unavailable('native document export'),
    getLanguage: async () => handle.settings.language,
    onLanguageChanged: noListener,
    getTheme: async () => handle.settings.theme,
    onThemeChanged: noListener,
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
    onAutoSaveDefaultChanged: noListener,
    getAiPanelPrefs: async () => prefs,
    async setAiPanelPrefs(patch) {
      prefs = { ...prefs, ...patch }
      for (const listener of preferenceListeners) listener(prefs)
      return prefs
    },
    onAiPanelPrefsChanged(listener) {
      preferenceListeners.add(listener)
      return () => preferenceListeners.delete(listener)
    },
    onChromePressed: noListener,
    getAiSettings: async () => defaultAiSettings(),
    aiGskStatus: async () => ({ loggedIn: false }),
    aiStream: () => unavailable('the Electron AI transport'),
    aiStreamCancel: () => unavailable('the Electron AI transport'),
    onAiStream: noListener,
    webSearch: () => unavailable('renderer Web search'),
    imageSearch: () => unavailable('renderer image search'),
    fetchImage: () => unavailable('fetching external images'),
    aiGenerateImage: () => unavailable('renderer image generation'),
  }
  return new Proxy(implemented, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (value !== undefined) return value
      const name = String(property)
      if (name.startsWith('on')) return noListener
      return () => unavailable(name)
    },
  }) as MarkdownApi
}

export function installMarkdownBrowserHostApi(
  bootstrap: MarkdownBrowserBootstrap,
  options: InstallMarkdownBrowserHostOptions = {},
): MarkdownBrowserHostHandle {
  const target = options.target ?? (window as unknown as MarkdownBrowserHostTarget)
  const transport = options.transport ?? createHttpMarkdownBrowserTransport(bootstrap)
  const client = options.client ?? createNexusClient({ url: bootstrap.websocketUrl })
  const bridge = createMarkdownBrowserAgentBridge({
    client,
    documentId: bootstrap.documentId as import('@nexusdesk/protocol').DocumentId,
    revision: bootstrap.revision as import('@nexusdesk/protocol').Revision,
  })
  const document = { documentId: bootstrap.documentId, title: bootstrap.title, revision: bootstrap.revision }
  const settings = { language: bootstrap.language, theme: bootstrap.theme }
  let disposed = false
  let api!: MarkdownApi
  const handle: MarkdownBrowserHostHandle = {
    document,
    settings,
    bridge,
    get api() {
      return api
    },
    updateRevision(revision) {
      document.revision = revision
      bridge.updateRevision(revision as import('@nexusdesk/protocol').Revision)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (target.markdownApi === api) delete target.markdownApi
      if (target.agentApi === bridge.agentApi) delete target.agentApi
      if (target.nexusdeskMarkdownHost === handle) delete target.nexusdeskMarkdownHost
      bridge.dispose()
      client.close()
    },
  }
  api = createMarkdownBrowserApi(handle, transport)
  target.markdownApi = api
  target.agentApi = bridge.agentApi
  target.nexusdeskMarkdownHost = handle
  client.connect()
  return handle
}

export async function installMarkdownBrowserHostApiForDocument(
  documentId: string,
): Promise<MarkdownBrowserHostHandle> {
  return installMarkdownBrowserHostApi(await loadMarkdownBrowserBootstrap(documentId))
}

export async function selectMarkdownHost(options: {
  search: string
  electronApi: unknown
  installBrowser(documentId: string): Promise<MarkdownBrowserHostHandle>
}): Promise<{ kind: 'local-web'; handle: MarkdownBrowserHostHandle } | { kind: 'electron' } | { kind: 'error'; message: string }> {
  const parameters = new URLSearchParams(options.search)
  if (parameters.get('host') === 'local-web') {
    const documentId = parameters.get('documentId')
    if (!documentId) return { kind: 'error', message: 'NexusDesk Markdown could not start: local Web mode requires a document id.' }
    return { kind: 'local-web', handle: await options.installBrowser(documentId) }
  }
  if (options.electronApi !== undefined && options.electronApi !== null) return { kind: 'electron' }
  return { kind: 'error', message: 'NexusDesk Markdown could not start: no supported host is available.' }
}
