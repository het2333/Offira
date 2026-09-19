import { defaultAiSettings } from '@genoffice/ai-provider/browser'
import { DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import type { DocumentId, EditorAdapter, Revision } from '@nexusdesk/protocol'
import {
  createNexusClient,
  type AgentApi,
  type NexusClient,
} from '@nexusdesk/web-client'

import {
  createBrowserAgentBridge,
  type BrowserAgentBridge,
} from './agent/browser-agent-api'
import type {
  DesktopApi,
  UiTheme,
  WorkbookFile,
} from '../shared/desktop-api'

export interface BrowserHostBootstrap {
  documentId: DocumentId
  title: string
  revision: Revision
  websocketUrl: string
  language: Awaited<ReturnType<DesktopApi['getLanguage']>>
  theme: UiTheme
  workbook: WorkbookFile
}

export interface BrowserHostTransport {
  request<T>(action: string, payload?: unknown): Promise<T>
}

export interface BrowserHostTarget {
  desktopApi?: DesktopApi
  agentApi?: AgentApi
  nexusdeskBrowserHost?: BrowserHostHandle
}

export interface InstallBrowserHostOptions {
  client?: NexusClient
  target?: BrowserHostTarget
  transport?: BrowserHostTransport
}

export class WebHostUnavailableError extends Error {
  readonly code = 'UNAVAILABLE_IN_WEB' as const

  constructor(capability: string) {
    super(`${capability} is unavailable in Web Sheets`)
    this.name = 'WebHostUnavailableError'
  }
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new WebHostUnavailableError(capability))
}

function noListener(): () => void {
  return () => undefined
}

export function createBrowserDesktopApi(
  bootstrap: BrowserHostBootstrap,
  transport: BrowserHostTransport,
): DesktopApi {
  let queuedWorkbook: WorkbookFile | undefined = bootstrap.workbook
  let aiPanelPrefs: AiPanelPrefs = DEFAULT_AI_PANEL_PREFS
  const aiPanelListeners = new Set<(prefs: AiPanelPrefs) => void>()

  return {
    getLanguage: async () => bootstrap.language,
    onLanguageChanged: noListener,
    getTheme: async () => bootstrap.theme,
    onThemeChanged: noListener,
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
    onAutoSaveDefaultChanged: noListener,
    getAiPanelPrefs: async () => aiPanelPrefs,
    async setAiPanelPrefs(patch) {
      aiPanelPrefs = { ...aiPanelPrefs, ...patch }
      for (const listener of aiPanelListeners) listener(aiPanelPrefs)
      return aiPanelPrefs
    },
    onAiPanelPrefsChanged(handler) {
      aiPanelListeners.add(handler)
      return () => aiPanelListeners.delete(handler)
    },
    onChromePressed: noListener,
    async selectWorkbook() {
      const workbook = queuedWorkbook ?? null
      queuedWorkbook = undefined
      return workbook
    },
    selectWorkbooksForMerge: () => unavailable('selecting workbooks for merge'),
    openWorkbooksForMerge: () => unavailable('opening merge workbooks'),
    readWorkbookRange: (request) => transport.request('read-workbook-range', request),
    readWorkbookFormulas: (request) => transport.request('read-workbook-formulas', request),
    recalcWorkbook: (request) => transport.request('recalculate-workbook', request),
    readWorkbookMedia: (request) => transport.request('read-workbook-media', request),
    readPivotDefinition: (request) => transport.request('read-pivot-definition', request),
    readLocalImage: () => unavailable('reading a local image path'),
    captureScreenSources: () => unavailable('screen capture'),
    captureScreenSource: () => unavailable('screen capture'),
    saveWorkbookEdits: (request) => transport.request('save-workbook', request),
    beginSaveEditsTransfer: (request) => transport.request('begin-save-edits-transfer', request),
    sendSaveEditsChunk: (request) => transport.request('send-save-edits-chunk', request),
    abortSaveEditsTransfer: (request) => transport.request('abort-save-edits-transfer', request),
    writeWorkbookRecovery: (request) => transport.request('write-workbook-recovery', request),
    autoRenameWorkbook: (sessionId, baseName) =>
      transport.request('auto-rename-workbook', { sessionId, baseName }),
    exportPdf: () => unavailable('PDF export'),
    printWorkbook: () => unavailable('printing'),
    exportCsv: () => unavailable('CSV export'),
    confirmCsvSave: () => unavailable('native CSV save confirmation'),
    createDocument: () => unavailable('creating a separate document'),
    closeWorkbook: (sessionId) => transport.request('close-workbook', { sessionId }),
    async openExternal(url) {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new WebHostUnavailableError('opening non-HTTP links')
      }
      globalThis.open?.(parsed.href, '_blank', 'noopener,noreferrer')
    },
    onMenuAction: noListener,
    onWorkbookRenamed: noListener,
    notifyPendingEdits: () => undefined,
    onCloseSaveRequest: noListener,
    reportCloseSaveResult: () => undefined,
    onRecoveryPrompt: noListener,
    replyRecoveryPrompt: () => undefined,
    consumeNewBlankWorkbook: async () => false,
    onMcpCommand: noListener,
    reportMcpResult: () => undefined,
    signalMcpReady: () => undefined,
    hasQueuedWorkbook: async () => queuedWorkbook !== undefined,
    consumeHeadlessExport: async () => null,
    headlessExportDone: () => undefined,
    getAiSettings: async () => defaultAiSettings(),
    setAiSettings: () => unavailable('editing model settings from the Sheets frame'),
    aiChat: () => unavailable('the Electron AI transport'),
    aiStream: () => unavailable('the Electron AI transport'),
    aiStreamCancel: () => unavailable('the Electron AI transport'),
    aiGskStatus: async () => ({ loggedIn: false }),
    aiGskLogin: () => unavailable('Genspark login from the Sheets frame'),
    webSearch: () => unavailable('renderer web search'),
    imageSearch: () => unavailable('renderer image search'),
    generateImage: () => unavailable('renderer image generation'),
    fetchImage: (url) => transport.request('fetch-image', { url }),
    onAiStream: noListener,
    pickAttachments: () => unavailable('native attachment picker'),
    addAttachmentPaths: () => unavailable('local attachment paths'),
    addPastedImage: () => unavailable('persisting pasted images'),
    readAttachment: (path, offset, maxChars) =>
      transport.request('read-attachment', { path, offset, maxChars }),
    readAttachmentImage: (path) => transport.request('read-attachment-image', { path }),
    getPathForFile() {
      throw new WebHostUnavailableError('resolving a browser File to a local path')
    },
  }
}

export function createHttpBrowserHostTransport(
  documentId: DocumentId,
  fetchImpl: typeof fetch = globalThis.fetch,
): BrowserHostTransport {
  return {
    async request<T>(action: string, payload?: unknown): Promise<T> {
      const response = await fetchImpl(
        `/api/documents/${encodeURIComponent(documentId)}/${encodeURIComponent(action)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        },
      )
      const value = await response.json() as unknown
      if (!response.ok) {
        const message =
          typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string'
            ? (value as { error: string }).error
            : `Local Host request failed with HTTP ${String(response.status)}`
        throw new Error(message)
      }
      return value as T
    },
  }
}

export interface BrowserHostHandle {
  readonly document: Pick<BrowserHostBootstrap, 'documentId' | 'title' | 'revision'>
  readonly bridge: BrowserAgentBridge
  attachEditor(adapter: EditorAdapter): void
  updateRevision(revision: Revision): void
  dispose(): void
}

export function installBrowserHostApi(
  bootstrap: BrowserHostBootstrap,
  options: InstallBrowserHostOptions = {},
): BrowserHostHandle {
  const target = options.target ?? (window as unknown as BrowserHostTarget)
  const client = options.client ?? createNexusClient({ url: bootstrap.websocketUrl })
  const transport = options.transport ?? createHttpBrowserHostTransport(bootstrap.documentId)
  const bridge = createBrowserAgentBridge({
    client,
    documentId: bootstrap.documentId,
    revision: bootstrap.revision,
  })
  const desktopApi = createBrowserDesktopApi(bootstrap, transport)
  const document = {
    documentId: bootstrap.documentId,
    title: bootstrap.title,
    revision: bootstrap.revision,
  }
  let disposed = false
  const handle: BrowserHostHandle = {
    document,
    bridge,
    attachEditor(adapter) {
      bridge.attachEditor(adapter)
    },
    updateRevision(revision) {
      document.revision = revision
      bridge.updateRevision(revision)
    },
    dispose() {
      if (disposed) return
      disposed = true
      bridge.dispose()
      client.close()
      if (target.desktopApi === desktopApi) delete target.desktopApi
      if (target.agentApi === bridge.agentApi) delete target.agentApi
      if (target.nexusdeskBrowserHost === handle) delete target.nexusdeskBrowserHost
    },
  }
  target.desktopApi = desktopApi
  target.agentApi = bridge.agentApi
  target.nexusdeskBrowserHost = handle
  client.connect()
  return handle
}

export type SheetsHostSelection =
  | { kind: 'local-web'; handle: BrowserHostHandle }
  | { kind: 'electron' }
  | { kind: 'error'; message: string }

export interface SelectSheetsHostOptions {
  search: string
  electronApi: unknown
  installBrowser(): Promise<BrowserHostHandle>
}

export async function selectSheetsHost(
  options: SelectSheetsHostOptions,
): Promise<SheetsHostSelection> {
  const requestedHost = new URLSearchParams(options.search).get('host')
  if (requestedHost === 'local-web') {
    return { kind: 'local-web', handle: await options.installBrowser() }
  }
  if (options.electronApi !== undefined && options.electronApi !== null) {
    return { kind: 'electron' }
  }
  return {
    kind: 'error',
    message:
      'NexusDesk Sheets could not start: Electron preload is unavailable and local Web mode was not requested.',
  }
}
