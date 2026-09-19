import { defaultAiSettings } from '@genoffice/ai-provider/browser'
import { DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import type { DocumentId, Revision } from '@nexusdesk/protocol'
import type { PdfCapabilities, PdfPageModification } from '../shared/web-capabilities'
import { createNexusClient, type AgentApi, type NexusClient } from '@nexusdesk/web-client'

import type {
  ImageEditFailure,
  PageImageRef,
  PdfApi,
  SavePdfRequest,
  TextEditFailure,
  TextInsertFailure,
  UiTheme,
} from '../shared/ipc'
import {
  createPdfBrowserAgentBridge,
  type PdfBrowserAgentBridge,
  type PdfEditorAdapter,
} from './agent/browser-agent-api'

export interface PdfBrowserBootstrap {
  documentId: string
  title: string
  revision: number
  websocketUrl: string
  language: string
  theme: UiTheme
  contentUrl: string
  capabilities: PdfCapabilities
}

export interface PdfBrowserWriteResult {
  document: {
    documentId: string
    title: string
    editorType: 'pdf'
    revision: number
  }
  skippedTextEdits?: TextEditFailure[]
  skippedTextInserts?: TextInsertFailure[]
  skippedImageEdits?: ImageEditFailure[]
}

export interface PdfBrowserTransport {
  readContent(): Promise<Uint8Array>
  listPageImages(): Promise<PageImageRef[]>
  save(request: SavePdfRequest, expectedRevision: number): Promise<PdfBrowserWriteResult>
  modifyPages(
    modification: PdfPageModification,
    expectedRevision: number,
  ): Promise<PdfBrowserWriteResult>
  pageImagePng(request: {
    pageIndex: number
    rect: [number, number, number, number]
    scale?: number
  }): Promise<string | null>
}

export interface PdfBrowserHostState {
  document: PdfBrowserBootstrap
  updateRevision(revision: number): void
}

export class PdfWebUnavailableError extends Error {
  readonly code = 'UNAVAILABLE_IN_WEB' as const

  constructor(capability: string) {
    super(`${capability} is unavailable in Web PDF`)
    this.name = 'PdfWebUnavailableError'
  }
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new PdfWebUnavailableError(capability))
}

function noListener(): () => void {
  return () => undefined
}

function virtualPath(documentId: string): string {
  return `nexusdesk://${documentId}`
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function hostError(response: Response): Promise<Error> {
  let message = `Local Host request failed with HTTP ${String(response.status)}`
  try {
    const value = (await response.json()) as { message?: unknown; error?: unknown }
    if (typeof value.message === 'string') message = value.message
    else if (typeof value.error === 'string') message = value.error
  } catch {
    // A status is an honest fallback when the Host did not return JSON.
  }
  return new Error(message)
}

export async function loadPdfBrowserBootstrap(
  documentId: string,
  fetchBootstrap: typeof fetch = globalThis.fetch,
): Promise<PdfBrowserBootstrap> {
  const response = await fetchBootstrap(
    `/api/documents/${encodeURIComponent(documentId)}/bootstrap`,
    { credentials: 'same-origin' },
  )
  if (!response.ok)
    throw new Error(`Document bootstrap failed with HTTP ${String(response.status)}`)
  const value = (await response.json()) as Partial<PdfBrowserBootstrap>
  if (
    typeof value.documentId !== 'string' ||
    typeof value.title !== 'string' ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.websocketUrl !== 'string' ||
    typeof value.language !== 'string' ||
    (value.theme !== 'light' && value.theme !== 'dark' && value.theme !== 'system') ||
    typeof value.contentUrl !== 'string' ||
    value.capabilities?.saveInPlace !== true ||
    value.capabilities.textReflow !== false
  ) {
    throw new Error('Local Host returned an invalid PDF bootstrap')
  }
  return value as PdfBrowserBootstrap
}

export function createHttpPdfBrowserTransport(
  bootstrap: PdfBrowserBootstrap,
  fetchImpl: typeof fetch = globalThis.fetch,
): PdfBrowserTransport {
  const post = async (action: string, body: unknown) => {
    const response = await fetchImpl(
      `/api/documents/${encodeURIComponent(bootstrap.documentId)}/${action}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!response.ok) throw await hostError(response)
    return response.json()
  }
  return {
    async modifyPages(modification, expectedRevision) {
      const value = (await post('modify-pages', {
        modification,
        expectedRevision,
      })) as PdfBrowserWriteResult
      if (
        value.document?.documentId !== bootstrap.documentId ||
        value.document.editorType !== 'pdf' ||
        !Number.isSafeInteger(value.document.revision) ||
        value.document.revision <= expectedRevision
      )
        throw new Error('Local Host returned an invalid PDF rewrite result')
      return value
    },
    async pageImagePng(request) {
      const value = (await post('page-image-png', request)) as { png: unknown }
      if (value.png !== null && typeof value.png !== 'string')
        throw new Error('Invalid PDF image preview')
      return value.png
    },
    async readContent() {
      const response = await fetchImpl(bootstrap.contentUrl, { credentials: 'same-origin' })
      if (!response.ok) throw await hostError(response)
      return new Uint8Array(await response.arrayBuffer())
    },
    async listPageImages() {
      const response = await fetchImpl(
        `/api/documents/${encodeURIComponent(bootstrap.documentId)}/list-page-images`,
        { method: 'POST', credentials: 'same-origin' },
      )
      if (!response.ok) throw await hostError(response)
      const value = (await response.json()) as { images?: unknown }
      if (!Array.isArray(value.images))
        throw new Error('Local Host returned invalid PDF image data')
      return value.images as PageImageRef[]
    },
    async save(request, expectedRevision) {
      const response = await fetchImpl(
        `/api/documents/${encodeURIComponent(bootstrap.documentId)}/save`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRevision, request }),
        },
      )
      if (!response.ok) throw await hostError(response)
      const value = (await response.json()) as Partial<PdfBrowserWriteResult>
      const document = value.document
      if (
        document?.documentId !== bootstrap.documentId ||
        document.editorType !== 'pdf' ||
        typeof document.title !== 'string' ||
        !Number.isSafeInteger(document.revision) ||
        document.revision <= expectedRevision
      ) {
        throw new Error('Local Host returned an invalid PDF save result')
      }
      return value as PdfBrowserWriteResult
    },
  }
}

/** Build the preload-shaped API required by the existing GenOffice PDF renderer. */
export function createPdfBrowserApi(
  state: PdfBrowserHostState,
  transport: PdfBrowserTransport,
): PdfApi {
  let pending = true
  let aiPanelPrefs: AiPanelPrefs = DEFAULT_AI_PANEL_PREFS
  const prefsListeners = new Set<(prefs: AiPanelPrefs) => void>()
  const path = virtualPath(state.document.documentId)
  const rewrite = async (candidate: string, modification: PdfPageModification) => {
    if (candidate !== path || !state.document.capabilities.pageRewriting)
      return {
        ok: false as const,
        error: 'Page rewriting requires the Host-authorized PDF capability.',
      }
    try {
      const result = await transport.modifyPages(modification, state.document.revision)
      state.document.revision = result.document.revision
      state.updateRevision(result.document.revision)
      return { ok: true as const }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'PDF rewrite failed',
      }
    }
  }
  const api: Partial<PdfApi> = {
    insertBlankPage: ({ path, afterPageIndex }) =>
      rewrite(path, { action: 'insertBlankPage', afterPageIndex }),
    setPageSize: ({ path, width, height }) =>
      rewrite(path, { action: 'setPageSize', width, height }),
    cropPages: ({ path, pages, rect }) => rewrite(path, { action: 'cropPages', pages, rect }),
    async consumePending() {
      if (!pending) return null
      pending = false
      return path
    },
    async readFile(candidate) {
      if (candidate !== path)
        throw new PdfWebUnavailableError('reading an arbitrary filesystem path')
      return toArrayBuffer(await transport.readContent())
    },
    async save(request) {
      if (request.path !== path || request.targetPath !== undefined) {
        return { ok: false, error: 'Web PDF can save only the Host-authorized document.' }
      }
      try {
        const result = await transport.save(request, state.document.revision)
        state.document.revision = result.document.revision
        state.updateRevision(result.document.revision)
        return {
          ok: true,
          ...(result.skippedTextEdits === undefined
            ? {}
            : { skippedTextEdits: result.skippedTextEdits }),
          ...(result.skippedTextInserts === undefined
            ? {}
            : { skippedTextInserts: result.skippedTextInserts }),
          ...(result.skippedImageEdits === undefined
            ? {}
            : { skippedImageEdits: result.skippedImageEdits }),
        }
      } catch (error: unknown) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Local Host rejected the PDF save.',
        }
      }
    },
    autoRename: async () => ({ renamed: false }),
    isUntitled: async () => false,
    listEditFonts: async () => [],
    // Mirrors text-edit.ts' Base 14 Helvetica path. This is a PDF-standard font,
    // so Local Web can truthfully enable ordinary Latin insertion without probing
    // machine fonts that the browser cannot inspect.
    canDrawText: async (text) => text.length > 0 && /^[\x20-\x7e\r\n]*$/.test(text),
    listPageImages: () => transport.listPageImages(),
    listStaticFormFills: async () => [],
    ocrPage: async () => null,
    pageImagePng: ({ path: candidate, pageIndex, rect, scale }) => {
      if (candidate !== path || !state.document.capabilities.imageEditing)
        return unavailable('image pixels')
      return transport.pageImagePng({ pageIndex, rect, ...(scale === undefined ? {} : { scale }) })
    },
    pagePreviewPng: async () => null,
    getUsername: async () => '',
    setDirty: () => undefined,
    onCloseSaveRequest: noListener,
    sendCloseSaveResult: () => undefined,
    onSaveAsRequest: noListener,
    sendSaveAsResult: () => undefined,
    onSaveAsFlow: noListener,
    onPrintRequest: noListener,
    onFileRenamed: noListener,
    getLanguage: async () => state.document.language as never,
    onLanguageChanged: noListener,
    getTheme: async () => state.document.theme,
    onThemeChanged: noListener,
    getAiPanelPrefs: async () => aiPanelPrefs,
    async setAiPanelPrefs(patch) {
      aiPanelPrefs = { ...aiPanelPrefs, ...patch }
      for (const listener of prefsListeners) listener(aiPanelPrefs)
      return aiPanelPrefs
    },
    onAiPanelPrefsChanged(listener) {
      prefsListeners.add(listener)
      return () => prefsListeners.delete(listener)
    },
    onChromePressed: noListener,
    getAiSettings: async () => defaultAiSettings(),
    gskStatus: async () => ({ loggedIn: false }),
    onAiStream: noListener,
  }
  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (value !== undefined) return value
      const name = String(property)
      if (name.startsWith('on')) return noListener
      if (name.startsWith('send') || name === 'setDirty') return () => undefined
      return () => unavailable(name)
    },
  }) as PdfApi
}

export interface PdfBrowserHostHandle {
  readonly document: PdfBrowserBootstrap
  readonly capabilities: PdfBrowserBootstrap['capabilities']
  readonly pdfApi: PdfApi
  readonly bridge: PdfBrowserAgentBridge
  attachEditor(adapter: PdfEditorAdapter): () => void
  updateRevision(revision: number): void
  dispose(): void
}

export interface PdfBrowserHostTarget {
  pdfApi?: PdfApi
  agentApi?: AgentApi
  nexusdeskPdfHost?: PdfBrowserHostHandle
}

export interface InstallPdfBrowserHostOptions {
  client?: NexusClient
  target?: PdfBrowserHostTarget
  transport?: PdfBrowserTransport
}

export function installPdfBrowserHostApi(
  bootstrap: PdfBrowserBootstrap,
  options: InstallPdfBrowserHostOptions = {},
): PdfBrowserHostHandle {
  const target = options.target ?? (window as unknown as PdfBrowserHostTarget)
  const client = options.client ?? createNexusClient({ url: bootstrap.websocketUrl })
  const bridge = createPdfBrowserAgentBridge({
    client,
    documentId: bootstrap.documentId as DocumentId,
    revision: bootstrap.revision as Revision,
  })
  let disposed = false
  const handle: PdfBrowserHostHandle = {
    document: bootstrap,
    capabilities: bootstrap.capabilities,
    pdfApi: undefined as never,
    bridge,
    attachEditor(adapter) {
      return bridge.attachEditor(adapter)
    },
    updateRevision(revision) {
      bootstrap.revision = revision
      bridge.updateRevision(revision as Revision)
    },
    dispose() {
      if (disposed) return
      disposed = true
      bridge.dispose()
      client.close()
      if (target.pdfApi === handle.pdfApi) delete target.pdfApi
      if (target.agentApi === bridge.agentApi) delete target.agentApi
      if (target.nexusdeskPdfHost === handle) delete target.nexusdeskPdfHost
    },
  }
  const pdfApi = createPdfBrowserApi(
    handle,
    options.transport ?? createHttpPdfBrowserTransport(bootstrap),
  )
  Object.defineProperty(handle, 'pdfApi', { value: pdfApi })
  target.pdfApi = pdfApi
  target.agentApi = bridge.agentApi
  target.nexusdeskPdfHost = handle
  client.connect()
  return handle
}

export type PdfHostSelection =
  | { kind: 'local-web'; handle: PdfBrowserHostHandle }
  | { kind: 'electron' }
  | { kind: 'error'; message: string }

export async function selectPdfHost(options: {
  search: string
  electronApi: unknown
  installBrowser(documentId: string): Promise<PdfBrowserHostHandle>
}): Promise<PdfHostSelection> {
  const parameters = new URLSearchParams(options.search)
  if (parameters.get('host') === 'local-web') {
    const documentId = parameters.get('documentId')
    if (!documentId) {
      return {
        kind: 'error',
        message: 'NexusDesk PDF could not start: local Web mode requires a document id.',
      }
    }
    return { kind: 'local-web', handle: await options.installBrowser(documentId) }
  }
  if (options.electronApi !== undefined && options.electronApi !== null) return { kind: 'electron' }
  return { kind: 'error', message: 'NexusDesk PDF requires the Local Host or Electron.' }
}

export async function installPdfBrowserHostApiForDocument(
  documentId: string,
): Promise<PdfBrowserHostHandle> {
  return installPdfBrowserHostApi(await loadPdfBrowserBootstrap(documentId))
}
