import { defaultAiSettings } from '@genoffice/ai-provider/browser'
import { DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import { createNexusClient, type AgentApi, type NexusClient } from '@nexusdesk/web-client'

import type { HtmlApi, SaveHtmlResult, UiTheme } from '../shared/ipc'
import { createHtmlBrowserAgentBridge, type HtmlBrowserAgentBridge } from './agent/browser-agent-api'

type HtmlLanguage = Awaited<ReturnType<HtmlApi['getLanguage']>>

export interface HtmlBrowserBootstrap {
  documentId: string
  title: string
  revision: number
  websocketUrl: string
  language: HtmlLanguage
  theme: UiTheme
  contentUrl: string
  recoveryUrl: string
  previewUrl: string
}

export interface HtmlDocumentWriteResult {
  documentId: string
  title: string
  editorType: 'html'
  revision: number
}

export interface HtmlBrowserTransport {
  readContent(): Promise<Uint8Array>
  writeContent(bytes: Uint8Array, expectedRevision: number): Promise<HtmlDocumentWriteResult>
  writeRecovery(bytes: Uint8Array, expectedRevision: number): Promise<void>
  updatePreview(text: string): Promise<void>
}

export interface HtmlBrowserHostHandle {
  readonly document: { readonly documentId: string; readonly title: string; revision: number }
  readonly settings: Pick<HtmlBrowserBootstrap, 'language' | 'theme' | 'previewUrl'>
  readonly api: HtmlApi
  readonly bridge: HtmlBrowserAgentBridge
  updateRecovery(text: string): Promise<void>
  updateRevision(revision: number): void
  dispose(): void
}

export interface HtmlBrowserHostTarget {
  htmlApi?: HtmlApi
  agentApi?: AgentApi
  nexusdeskHtmlHost?: HtmlBrowserHostHandle
}

export interface InstallHtmlBrowserHostOptions {
  target?: HtmlBrowserHostTarget
  transport?: HtmlBrowserTransport
  client?: NexusClient
}

export class HtmlWebUnavailableError extends Error {
  readonly code = 'UNAVAILABLE_IN_WEB' as const
  constructor(capability: string) {
    super(`${capability} is unavailable in Web HTML`)
    this.name = 'HtmlWebUnavailableError'
  }
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new HtmlWebUnavailableError(capability))
}
function noListener(): () => void { return () => undefined }
function virtualPath(documentId: string): string { return `nexusdesk://${documentId}` }
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer { const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); return copy.buffer }

async function hostError(response: Response): Promise<Error> {
  let message = `Local Host request failed with HTTP ${String(response.status)}`
  try {
    const value = (await response.json()) as { message?: unknown; error?: unknown }
    if (typeof value.message === 'string') message = value.message
    else if (typeof value.error === 'string') message = value.error
  } catch { /* retain HTTP status */ }
  return new Error(message)
}

export async function loadHtmlBrowserBootstrap(documentId: string, fetchBootstrap: typeof fetch = globalThis.fetch): Promise<HtmlBrowserBootstrap> {
  const response = await fetchBootstrap(`/api/documents/${encodeURIComponent(documentId)}/bootstrap`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Document bootstrap failed with HTTP ${String(response.status)}`)
  const value = (await response.json()) as Partial<HtmlBrowserBootstrap>
  if (typeof value.documentId !== 'string' || typeof value.title !== 'string' || !Number.isSafeInteger(value.revision) || typeof value.websocketUrl !== 'string' || typeof value.language !== 'string' || typeof value.theme !== 'string' || typeof value.contentUrl !== 'string' || typeof value.recoveryUrl !== 'string' || typeof value.previewUrl !== 'string') {
    throw new Error('Local Host returned an invalid HTML bootstrap')
  }
  return value as HtmlBrowserBootstrap
}

export function createHttpHtmlBrowserTransport(bootstrap: HtmlBrowserBootstrap, fetchImpl: typeof fetch = globalThis.fetch): HtmlBrowserTransport {
  return {
    async readContent() {
      const response = await fetchImpl(bootstrap.contentUrl, { credentials: 'same-origin' })
      if (!response.ok) throw await hostError(response)
      return new Uint8Array(await response.arrayBuffer())
    },
    async writeContent(bytes, expectedRevision) {
      const response = await fetchImpl(bootstrap.contentUrl, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'If-Match': String(expectedRevision) }, body: toArrayBuffer(bytes) })
      if (!response.ok) throw await hostError(response)
      const value = (await response.json()) as Partial<HtmlDocumentWriteResult>
      if (value.documentId !== bootstrap.documentId || value.editorType !== 'html' || typeof value.title !== 'string' || !Number.isSafeInteger(value.revision) || (value.revision ?? 0) <= expectedRevision) throw new Error('Local Host returned an invalid HTML write result')
      return value as HtmlDocumentWriteResult
    },
    async writeRecovery(bytes, expectedRevision) {
      const response = await fetchImpl(bootstrap.recoveryUrl, {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'If-Match': String(expectedRevision) }, body: toArrayBuffer(bytes),
      })
      if (!response.ok) throw await hostError(response)
    },
    async updatePreview(text) {
      const response = await fetchImpl(bootstrap.previewUrl, {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: text,
      })
      if (!response.ok) throw await hostError(response)
    },
  }
}

/** Preload-shaped, browser-safe surface for the existing HTML renderer. */
export function createHtmlBrowserApi(handle: Pick<HtmlBrowserHostHandle, 'document' | 'settings' | 'updateRevision'>, transport: HtmlBrowserTransport): HtmlApi {
  let pending = true
  let prefs: AiPanelPrefs = DEFAULT_AI_PANEL_PREFS
  const preferenceListeners = new Set<(next: AiPanelPrefs) => void>()
  const path = virtualPath(handle.document.documentId)
  const implemented: Partial<HtmlApi> = {
    async consumePending() { if (!pending) return null; pending = false; return path },
    consumeHeadlessExport: async () => null,
    headlessExportDone: () => undefined,
    async readFile(candidate) { if (candidate !== path) throw new HtmlWebUnavailableError('opening an arbitrary filesystem path'); return new TextDecoder('utf-8', { fatal: true }).decode(await transport.readContent()) },
    updatePreview(text) { return transport.updatePreview(text) },
    getPreviewInfo: async () => ({ url: handle.settings.previewUrl }),
    setPresentFullScreen: () => unavailable('native full screen'),
    presentInNewTab: () => unavailable('native presentation tabs'),
    async save(request): Promise<SaveHtmlResult> {
      if (request.mode !== 'save') return { ok: false, error: 'Save As is unavailable in Web HTML.' }
      try { const result = await transport.writeContent(new TextEncoder().encode(request.text), handle.document.revision); handle.updateRevision(result.revision); return { ok: true, path } }
      catch (error: unknown) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    },
    setDirty: () => undefined,
    onSaveRequest: noListener, sendSaveRequestAck: () => undefined, onReadTextRequest: noListener, sendReadTextResult: () => undefined, onCloseSaveRequest: noListener, sendCloseSaveResult: () => undefined, onFileRenamed: noListener, setProvisionalTitle: () => undefined,
    pickImage: () => unavailable('the native image picker'), saveImage: () => unavailable('saving local image assets'), readImage: async () => null,
    pickAttachments: () => unavailable('native attachment paths'), addAttachmentPaths: () => unavailable('native attachment paths'), addPastedImage: () => unavailable('pasted attachment persistence'), readAttachment: () => unavailable('native attachment paths'), readAttachmentImage: () => unavailable('native attachment paths'), getPathForFile: () => '',
    onExportRequest: noListener, onPrintRequest: noListener, exportDocx: () => unavailable('native document export'), exportPdf: () => unavailable('native document export'), exportHtml: () => unavailable('native document export'),
    getLanguage: async () => handle.settings.language, onLanguageChanged: noListener, getTheme: async () => handle.settings.theme, onThemeChanged: noListener, getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }), onAutoSaveDefaultChanged: noListener,
    getAiPanelPrefs: async () => prefs,
    async setAiPanelPrefs(patch) { prefs = { ...prefs, ...patch }; for (const listener of preferenceListeners) listener(prefs); return prefs },
    onAiPanelPrefsChanged(listener) { preferenceListeners.add(listener); return () => preferenceListeners.delete(listener) }, onChromePressed: noListener,
    getAiSettings: async () => defaultAiSettings(), aiGskStatus: async () => ({ loggedIn: false }), aiStream: () => unavailable('the Electron AI transport'), aiStreamCancel: () => unavailable('the Electron AI transport'), onAiStream: noListener, webSearch: () => unavailable('renderer Web search'), imageSearch: () => unavailable('renderer image search'), fetchImage: () => unavailable('fetching external images'), aiGenerateImage: () => unavailable('renderer image generation'),
  }
  return new Proxy(implemented, { get(target, property, receiver) { const value = Reflect.get(target, property, receiver); if (value !== undefined) return value; return String(property).startsWith('on') ? noListener : () => unavailable(String(property)) } }) as HtmlApi
}

export function installHtmlBrowserHostApi(bootstrap: HtmlBrowserBootstrap, options: InstallHtmlBrowserHostOptions = {}): HtmlBrowserHostHandle {
  const target = options.target ?? (window as unknown as HtmlBrowserHostTarget)
  const transport = options.transport ?? createHttpHtmlBrowserTransport(bootstrap)
  const client = options.client ?? createNexusClient({ url: bootstrap.websocketUrl })
  const bridge = createHtmlBrowserAgentBridge({ client, documentId: bootstrap.documentId as import('@nexusdesk/protocol').DocumentId, revision: bootstrap.revision as import('@nexusdesk/protocol').Revision })
  const document = { documentId: bootstrap.documentId, title: bootstrap.title, revision: bootstrap.revision }
  const settings = { language: bootstrap.language, theme: bootstrap.theme, previewUrl: bootstrap.previewUrl }
  let disposed = false
  let api!: HtmlApi
  const handle: HtmlBrowserHostHandle = { document, settings, bridge, get api() { return api }, updateRecovery(text) { return transport.writeRecovery(new TextEncoder().encode(text), document.revision) }, updateRevision(revision) { document.revision = revision; bridge.updateRevision(revision as import('@nexusdesk/protocol').Revision) }, dispose() { if (disposed) return; disposed = true; if (target.htmlApi === api) delete target.htmlApi; if (target.agentApi === bridge.agentApi) delete target.agentApi; if (target.nexusdeskHtmlHost === handle) delete target.nexusdeskHtmlHost; bridge.dispose(); client.close() } }
  api = createHtmlBrowserApi(handle, transport)
  target.htmlApi = api
  target.agentApi = bridge.agentApi
  target.nexusdeskHtmlHost = handle
  client.connect()
  return handle
}

export async function installHtmlBrowserHostApiForDocument(documentId: string): Promise<HtmlBrowserHostHandle> { return installHtmlBrowserHostApi(await loadHtmlBrowserBootstrap(documentId)) }
export async function selectHtmlHost(options: { search: string; electronApi: unknown; installBrowser(documentId: string): Promise<HtmlBrowserHostHandle> }): Promise<{ kind: 'local-web'; handle: HtmlBrowserHostHandle } | { kind: 'electron' } | { kind: 'error'; message: string }> {
  const parameters = new URLSearchParams(options.search)
  if (parameters.get('host') === 'local-web') { const documentId = parameters.get('documentId'); return documentId ? { kind: 'local-web', handle: await options.installBrowser(documentId) } : { kind: 'error', message: 'NexusDesk HTML could not start: local Web mode requires a document id.' } }
  return options.electronApi !== undefined && options.electronApi !== null ? { kind: 'electron' } : { kind: 'error', message: 'NexusDesk HTML could not start: no supported host is available.' }
}
