import { defaultAiSettings } from '@genoffice/ai-provider/browser'
import { DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import type { DocumentId, EditorAdapter, Revision } from '@nexusdesk/protocol'
import { createNexusClient, type AgentApi, type NexusClient } from '@nexusdesk/web-client'

import type { DesktopApi, OpenFileResult, UiTheme } from '../shared/ipc'
import {
  createDocsBrowserAgentBridge,
  type DocsBrowserAgentBridge,
} from './agent/browser-agent-api'

type DocsLanguage = Awaited<ReturnType<DesktopApi['getLanguage']>>

export interface DocsBrowserBootstrap {
  documentId: string
  title: string
  revision: number
  websocketUrl: string
  language: DocsLanguage
  theme: UiTheme
  contentUrl: string
}

export interface DocsDocumentWriteResult {
  documentId: string
  title: string
  editorType: 'docs'
  revision: number
}

export interface DocsBrowserTransport {
  readContent(): Promise<Uint8Array>
  writeContent(bytes: Uint8Array, expectedRevision: number): Promise<DocsDocumentWriteResult>
}

export interface DocsBrowserCapabilities {
  readonly openFile: false
  readonly saveInPlace: true
  readonly saveAs: false
  readonly encryption: false
  readonly print: false
  readonly zotero: false
  readonly externalAttachments: false
  readonly nativeProviderSettings: false
}

export interface DocsBrowserHostHandle {
  readonly document: {
    readonly documentId: string
    readonly title: string
    revision: number
  }
  readonly capabilities: DocsBrowserCapabilities
  readonly settings: Pick<DocsBrowserBootstrap, 'language' | 'theme'>
  readonly desktopApi: DesktopApi
  readonly bridge: DocsBrowserAgentBridge
  attachEditor(adapter: EditorAdapter): () => void
  updateRevision(revision: number): void
  dispose(): void
}

export interface DocsBrowserHostTarget {
  desktop?: DesktopApi
  agentApi?: AgentApi
  nexusdeskDocsHost?: DocsBrowserHostHandle
}

export interface InstallDocsBrowserHostOptions {
  client?: NexusClient
  target?: DocsBrowserHostTarget
  transport?: DocsBrowserTransport
}

export class DocsWebUnavailableError extends Error {
  readonly code = 'UNAVAILABLE_IN_WEB' as const

  constructor(capability: string) {
    super(`${capability} is unavailable in Web Docs`)
    this.name = 'DocsWebUnavailableError'
  }
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new DocsWebUnavailableError(capability))
}

function noListener(): () => void {
  return () => undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Local Host rejected the document save.'
}

function virtualPath(documentId: string): string {
  return `nexusdesk://${documentId}`
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function loadDocsBrowserBootstrap(
  documentId: string,
  fetchBootstrap: typeof fetch = globalThis.fetch,
): Promise<DocsBrowserBootstrap> {
  const response = await fetchBootstrap(
    `/api/documents/${encodeURIComponent(documentId)}/bootstrap`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) {
    throw new Error(`Document bootstrap failed with HTTP ${String(response.status)}`)
  }
  const value = (await response.json()) as Partial<DocsBrowserBootstrap>
  if (
    typeof value.documentId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.websocketUrl !== 'string' ||
    typeof value.language !== 'string' ||
    typeof value.theme !== 'string' ||
    typeof value.contentUrl !== 'string'
  ) {
    throw new Error('Local Host returned an invalid Docs bootstrap')
  }
  return value as DocsBrowserBootstrap
}

async function hostError(response: Response): Promise<Error> {
  let message = `Local Host request failed with HTTP ${String(response.status)}`
  let code: unknown
  try {
    const value = (await response.json()) as { message?: unknown; error?: unknown; code?: unknown }
    if (typeof value.message === 'string') message = value.message
    else if (typeof value.error === 'string') message = value.error
    code = value.code
  } catch {
    // The status remains an honest fallback for a non-JSON failure.
  }
  const error = new Error(message) as Error & { code?: string }
  if (typeof code === 'string') error.code = code
  return error
}

export function createHttpDocsBrowserTransport(
  bootstrap: DocsBrowserBootstrap,
  fetchImpl: typeof fetch = globalThis.fetch,
): DocsBrowserTransport {
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
        headers: {
          'Content-Type': 'application/octet-stream',
          'If-Match': String(expectedRevision),
        },
        body: toArrayBuffer(bytes),
      })
      if (!response.ok) throw await hostError(response)
      const value = (await response.json()) as Partial<DocsDocumentWriteResult>
      if (
        value.documentId !== bootstrap.documentId ||
        value.editorType !== 'docs' ||
        typeof value.title !== 'string' ||
        typeof value.revision !== 'number' ||
        !Number.isSafeInteger(value.revision) ||
        value.revision <= expectedRevision
      ) {
        throw new Error('Local Host returned an invalid document write result')
      }
      return value as DocsDocumentWriteResult
    },
  }
}

const VOID_METHODS = new Set([
  'respondToZotero',
  'headlessExportDone',
  'spellDiag',
  'reportMcpResult',
  'signalMcpReady',
  'reportCloseCheck',
  'reportCloseSaveResult',
  'reportViewMenuState',
])

/** Build the preload-shaped surface consumed by the unmodified Docs renderer. */
export function createDocsBrowserDesktopApi(
  handle: Pick<DocsBrowserHostHandle, 'document' | 'settings' | 'updateRevision'>,
  transport: DocsBrowserTransport,
): DesktopApi {
  let pending = true
  let aiPanelPrefs: AiPanelPrefs = DEFAULT_AI_PANEL_PREFS
  const aiPanelListeners = new Set<(prefs: AiPanelPrefs) => void>()
  const currentPath = virtualPath(handle.document.documentId)

  const implemented: Partial<DesktopApi> = {
    getLanguage: async () => handle.settings.language,
    onLanguageChanged: noListener,
    getTheme: async () => handle.settings.theme,
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
    openDocx: () => unavailable('the native file picker'),
    openDocxPath: () => unavailable('opening an arbitrary filesystem path'),
    openDocxDecrypt: () => unavailable('password-encrypted DOCX input'),
    convertAltChunkHtml: () => unavailable('native HTML conversion'),
    setDocPassword: () => unavailable('document encryption'),
    docPasswordIntentRevision: async () => 0,
    discardDocPasswordIntents: async () => ({ ok: true }),
    async consumePendingOpenDocx(): Promise<OpenFileResult | null> {
      if (!pending) return null
      pending = false
      const bytes = await transport.readContent()
      return {
        path: currentPath,
        name: handle.document.title,
        data: toArrayBuffer(bytes),
        hash: await sha256(bytes),
      }
    },
    consumeNewBlankDoc: async () => false,
    consumeAiDocContent: async () => null,
    consumeHeadlessExport: async () => null,
    createDocument: () => unavailable('creating a separate native document'),
    onOpenDocx: noListener,
    onRenamedDocx: noListener,
    async saveDocx(path, data) {
      if (path !== currentPath) {
        return { ok: false, error: 'Web Docs can save only the Host-authorized document.' }
      }
      try {
        const result = await transport.writeContent(new Uint8Array(data), handle.document.revision)
        handle.updateRevision(result.revision)
        return { ok: true }
      } catch (error: unknown) {
        return { ok: false, error: errorMessage(error) }
      }
    },
    writeRecoveryCopy: () => unavailable('Host recovery copies'),
    onTeardown: noListener,
    respellKick: async () => undefined,
    saveDocxAs: () => unavailable('Save As'),
    saveDocxNew: () => unavailable('saving a new native file'),
    saveDocxTo: () => unavailable('writing an arbitrary filesystem path'),
    onMcpCommand: noListener,
    getRecentFiles: async () => [],
    pickImage: () => unavailable('the native image picker'),
    fontMetrics: async () => null,
    getAiSettings: async () => defaultAiSettings(),
    setAiSettings: () => unavailable('native provider settings'),
    print: () => unavailable('native printing'),
    exportPdf: () => unavailable('native PDF export'),
    exportHtml: () => unavailable('native HTML export'),
    printPdfBuffer: () => unavailable('native PDF rendering'),
    saveMergedPdf: () => unavailable('native PDF export'),
    pickExportImagesTarget: () => unavailable('native image export'),
    takeExportPdf: () => unavailable('native image export'),
    writeExportImage: () => unavailable('native image export'),
    saveImageAs: () => unavailable('the native image save dialog'),
    onViewImage: noListener,
    aiChat: () => unavailable('the Electron AI transport'),
    aiStream: () => unavailable('the Electron AI transport'),
    aiStreamCancel: () => unavailable('the Electron AI transport'),
    aiGskStatus: async () => ({ loggedIn: false }),
    aiGskLogin: () => unavailable('Genspark login'),
    webSearch: () => unavailable('renderer Web search'),
    imageSearch: () => unavailable('renderer image search'),
    fetchImage: () => unavailable('fetching external images'),
    aiGenerateImage: () => unavailable('renderer image generation'),
    pickAttachments: () => unavailable('the native attachment picker'),
    addAttachmentPaths: () => unavailable('local attachment paths'),
    addPastedImage: () => unavailable('persisting pasted images'),
    copyImageToClipboard: () => unavailable('the OS image clipboard'),
    readAttachment: () => unavailable('reading a local attachment path'),
    readAttachmentImage: () => unavailable('reading a local attachment path'),
    getPathForFile() {
      throw new DocsWebUnavailableError('resolving a browser File to a local path')
    },
    openNewTab: () => unavailable('native Docs tabs'),
    listDocsTabs: async () => [],
    focusDocsTab: () => unavailable('native Docs tabs'),
    onAiStream: noListener,
    onMenuCommand: noListener,
    onCloseCheck: noListener,
    onCloseSaveRequest: noListener,
  }

  return new Proxy(implemented, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (value !== undefined) return value
      const name = String(property)
      if (name.startsWith('on')) return noListener
      if (VOID_METHODS.has(name)) return () => undefined
      return () => unavailable(name)
    },
  }) as DesktopApi
}

export function installDocsBrowserHostApi(
  bootstrap: DocsBrowserBootstrap,
  options: InstallDocsBrowserHostOptions = {},
): DocsBrowserHostHandle {
  const target = options.target ?? (window as unknown as DocsBrowserHostTarget)
  const transport = options.transport ?? createHttpDocsBrowserTransport(bootstrap)
  const client = options.client ?? createNexusClient({ url: bootstrap.websocketUrl })
  const bridge = createDocsBrowserAgentBridge({
    client,
    documentId: bootstrap.documentId as DocumentId,
    revision: bootstrap.revision as Revision,
  })
  const document = {
    documentId: bootstrap.documentId,
    title: bootstrap.title,
    revision: bootstrap.revision,
  }
  const capabilities: DocsBrowserCapabilities = {
    openFile: false,
    saveInPlace: true,
    saveAs: false,
    encryption: false,
    print: false,
    zotero: false,
    externalAttachments: false,
    nativeProviderSettings: false,
  }
  const settings = { language: bootstrap.language, theme: bootstrap.theme }
  let disposed = false
  let desktopApi!: DesktopApi
  const handle: DocsBrowserHostHandle = {
    document,
    capabilities,
    settings,
    bridge,
    get desktopApi() {
      return desktopApi
    },
    attachEditor(adapter) {
      return bridge.attachEditor(adapter)
    },
    updateRevision(revision) {
      document.revision = revision
      bridge.updateRevision(revision as Revision)
    },
    dispose() {
      if (disposed) return
      disposed = true
      bridge.dispose()
      client.close()
      if (target.desktop === desktopApi) delete target.desktop
      if (target.agentApi === bridge.agentApi) delete target.agentApi
      if (target.nexusdeskDocsHost === handle) delete target.nexusdeskDocsHost
    },
  }
  desktopApi = createDocsBrowserDesktopApi(handle, transport)
  target.desktop = desktopApi
  target.agentApi = bridge.agentApi
  target.nexusdeskDocsHost = handle
  client.connect()
  return handle
}

export async function installDocsBrowserHostApiForDocument(
  documentId: string,
): Promise<DocsBrowserHostHandle> {
  return installDocsBrowserHostApi(await loadDocsBrowserBootstrap(documentId))
}

export type DocsHostSelection =
  | { kind: 'local-web'; handle: DocsBrowserHostHandle }
  | { kind: 'electron' }
  | { kind: 'error'; message: string }

export interface SelectDocsHostOptions {
  search: string
  electronApi: unknown
  installBrowser(documentId: string): Promise<DocsBrowserHostHandle>
}

export async function selectDocsHost(options: SelectDocsHostOptions): Promise<DocsHostSelection> {
  const parameters = new URLSearchParams(options.search)
  if (parameters.get('host') === 'local-web') {
    const documentId = parameters.get('documentId')
    if (documentId === null || documentId.length === 0) {
      return {
        kind: 'error',
        message: 'NexusDesk Docs could not start: local Web mode requires a document id.',
      }
    }
    return { kind: 'local-web', handle: await options.installBrowser(documentId) }
  }
  if (options.electronApi !== undefined && options.electronApi !== null) {
    return { kind: 'electron' }
  }
  return {
    kind: 'error',
    message:
      'NexusDesk Docs could not start: Electron preload is unavailable and local Web mode was not requested.',
  }
}
