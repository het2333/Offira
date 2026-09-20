import { defaultAiSettings } from '@genoffice/ai-provider/browser'
import { DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import type { AgentApi, NexusClient } from '@nexusdesk/web-client'
import { createNexusClient } from '@nexusdesk/web-client'
import type { ClientId, DocumentId, JsonValue, Revision } from '@nexusdesk/protocol'

import type { ApplyEditScriptOp, ApplyTxnOp, ApplyTxnResult, EditTextOp, OpenResult, SlidesApi, UiTheme } from '../shared/ipc'
import { createSlidesBrowserAgentBridge, type SlidesBrowserAgentBridge } from './agent/browser-agent-api'
import { createSlidesEditorAdapter } from './agent/slides-editor-adapter'

type SlidesLanguage = Awaited<ReturnType<SlidesApi['getLanguage']>>

export interface SlidesBrowserBootstrap {
  documentId: string
  title: string
  revision: number
  contentVersion: number
  websocketUrl: string
  language: SlidesLanguage
  theme: UiTheme
}

export interface SlidesBrowserTransport {
  execute(action: string, payload: unknown): Promise<unknown>
}

export interface SlidesBrowserHostHandle {
  readonly document: { readonly documentId: string; readonly title: string; revision: number; contentVersion: number }
  readonly settings: Pick<SlidesBrowserBootstrap, 'language' | 'theme'>
  readonly slidesApi: SlidesApi
  readonly bridge: SlidesBrowserAgentBridge
  updateRevision(revision: number): void
  updateContentVersion(contentVersion: number): void
  dispose(): void
}

export interface SlidesBrowserHostTarget {
  slidesApi?: SlidesApi
  agentApi?: AgentApi
  nexusdeskSlidesHost?: SlidesBrowserHostHandle
}

export interface InstallSlidesBrowserHostOptions {
  target?: SlidesBrowserHostTarget
  transport?: SlidesBrowserTransport
  client?: NexusClient
}

export class SlidesWebUnavailableError extends Error {
  readonly code = 'UNAVAILABLE_IN_WEB' as const

  constructor(capability: string) {
    super(`${capability} is unavailable in Web Slides`)
    this.name = 'SlidesWebUnavailableError'
  }
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new SlidesWebUnavailableError(capability))
}

function noListener(): () => void {
  return () => undefined
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function openResult(value: unknown): OpenResult {
  const result = object(value)
  if (typeof result.path !== 'string' || !Array.isArray(result.slides) || typeof result.size !== 'object' || result.size === null) {
    throw new Error('Local Host returned an invalid Slides open result.')
  }
  return result as unknown as OpenResult
}

function saveResult(value: unknown): { ok: boolean; path?: string; slides?: OpenResult['slides']; revision?: number; error?: string } {
  const result = object(value)
  if (result.ok !== true || typeof result.revision !== 'number' || !Number.isSafeInteger(result.revision)) {
    throw new Error('Local Host returned an invalid Slides save result.')
  }
  return result as { ok: true; path?: string; slides?: OpenResult['slides']; revision: number }
}

function contentState(value: unknown): { contentVersion: number } {
  const result = object(value)
  if (typeof result.contentVersion !== 'number' || !Number.isSafeInteger(result.contentVersion) || result.contentVersion < 1) {
    throw new Error('Local Host returned an invalid Slides content version.')
  }
  return { contentVersion: result.contentVersion }
}

export function createSlidesBrowserApi(
  handle: Pick<SlidesBrowserHostHandle, 'document' | 'settings' | 'updateRevision' | 'updateContentVersion'>,
  transport: SlidesBrowserTransport,
): SlidesApi {
  let pending = true
  let aiPanelPrefs: AiPanelPrefs = DEFAULT_AI_PANEL_PREFS
  const aiPanelListeners = new Set<(prefs: AiPanelPrefs) => void>()
  const open = async (fitWidthPx: number): Promise<OpenResult> =>
    openResult(await transport.execute('slides:open', { fitWidthPx }))
  const syncContentVersion = async () => {
    handle.updateContentVersion(contentState(await transport.execute('slides:content-state', {})).contentVersion)
  }
  const ui = async <T>(action: string, payload: unknown): Promise<T> => {
    const result = await transport.execute('slides:ui', { action, payload }) as Record<string, unknown> | null
    if (result !== null && typeof result.contentVersion === 'number') handle.updateContentVersion(result.contentVersion)
    return result as T
  }
  const uiSlide = async (action: string, payload: unknown) => {
    const result = await ui<{ slide?: Awaited<ReturnType<SlidesApi['editFill']>>; contentVersion?: number } | null>(action, payload)
    return result?.slide ?? null
  }
  const implemented: Partial<SlidesApi> = {
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
    onAiPanelPrefsChanged(listener) {
      aiPanelListeners.add(listener)
      return () => aiPanelListeners.delete(listener)
    },
    onChromePressed: noListener,
    setShowFullScreen: async () => undefined,
    privateFontFaces: async () => [],
    privateFontData: async () => null,
    fontCatalog: async () => [],
    fontMissing: async () => [],
    onFontsChanged: noListener,
    consumePendingOpen: async (fitWidthPx) => {
      if (!pending) return null
      pending = false
      return open(fitWidthPx)
    },
    openPptx: () => unavailable('the native file picker'),
    openPptxPath: () => unavailable('opening an arbitrary filesystem path'),
    consumeHeadlessExport: async () => null,
    headlessExportDone: () => undefined,
    async editText(request: EditTextOp) {
      const result = await transport.execute('slides:edit-text', request) as Awaited<ReturnType<SlidesApi['editText']>>
      if (result !== null) await syncContentVersion()
      return result
    },
    async applyEditScript(request: ApplyEditScriptOp) {
      const result = await transport.execute('slides:apply-edit-script', request) as ({ slide: unknown; contentVersion?: number } | { error: string; contentVersion?: number } | null)
      if (result?.contentVersion !== undefined) handle.updateContentVersion(result.contentVersion)
      if (result === null) return null
      if ('slide' in result) return { slide: result.slide } as Awaited<ReturnType<SlidesApi['applyEditScript']>>
      return { error: result.error }
    },
    async applyTxn(request: ApplyTxnOp): Promise<ApplyTxnResult | null> {
      const result = await transport.execute('slides:apply-txn', request) as ApplyTxnResult | null
      if (result?.contentVersion !== undefined) handle.updateContentVersion(result.contentVersion)
      return result
    },
    addElement: (request) => ui<Awaited<ReturnType<SlidesApi['addElement']>>>('add-element', request),
    addTable: (request) => ui<Awaited<ReturnType<SlidesApi['addTable']>>>('add-table', request),
    addChart: (request) => ui<Awaited<ReturnType<SlidesApi['addChart']>>>('add-chart', request),
    addImageBytes: (request) => ui<Awaited<ReturnType<SlidesApi['addImageBytes']>>>('add-image-bytes', request),
    copyElements: (request) => ui<Awaited<ReturnType<SlidesApi['copyElements']>>>('copy-elements', request),
    pasteElements: (request) => ui<Awaited<ReturnType<SlidesApi['pasteElements']>>>('paste-elements', request),
    duplicateElements: (request) => ui<Awaited<ReturnType<SlidesApi['duplicateElements']>>>('duplicate-elements', request),
    deleteElement: (request) => uiSlide('delete-element', request),
    editFill: (request) => uiSlide('edit-fill', request),
    editStroke: (request) => uiSlide('edit-stroke', request),
    editTransform: (request) => uiSlide('edit-transform', request),
    addSlide: (request) => ui<Awaited<ReturnType<SlidesApi['addSlide']>>>('add-slide', request),
    addBlankSlide: (request) => ui<Awaited<ReturnType<SlidesApi['addBlankSlide']>>>('add-slide', { ...request, clearText: true }),
    async deleteSlide(slideIndex) {
      const result = await ui<{ slides?: Awaited<ReturnType<SlidesApi['deleteSlide']>>; contentVersion?: number } | null>('delete-slide', { slideIndex })
      return result?.slides ?? null
    },
    async moveSlide(request) {
      const result = await ui<{ slides?: Awaited<ReturnType<SlidesApi['deleteSlide']>>; contentVersion?: number } | null>('move-slide', request)
      const slides = result?.slides
      return slides === undefined || slides === null ? null : { slides, sections: [] }
    },
    async undo() {
      const result = await transport.execute('slides:undo', {}) as { slides?: Awaited<ReturnType<SlidesApi['undo']>>; contentVersion?: number } | null
      if (result?.contentVersion !== undefined) handle.updateContentVersion(result.contentVersion)
      return result?.slides ?? null
    },
    async redo() {
      const result = await transport.execute('slides:redo', {}) as { slides?: Awaited<ReturnType<SlidesApi['redo']>>; contentVersion?: number } | null
      if (result?.contentVersion !== undefined) handle.updateContentVersion(result.contentVersion)
      return result?.slides ?? null
    },
    getRenderSlides: async () => transport.execute('slides:render-slides', {}) as ReturnType<SlidesApi['getRenderSlides']>,
    isDirty: async () => transport.execute('slides:is-dirty', {}) as ReturnType<SlidesApi['isDirty']>,
    async save() {
      const result = saveResult(await transport.execute('slides:save', { expectedRevision: handle.document.revision }))
      handle.updateRevision(result.revision!)
      return result
    },
    onOpened: noListener,
    onRenamed: noListener,
    onDeckChanged: noListener,
    onHistoryChanged: noListener,
    getLayouts: async () => ({ layouts: [], size: { cx: 0, cy: 0 } }),
    getAiSettings: async () => defaultAiSettings(),
    getRecentFiles: async () => [],
    clipboardProbe: async () => false,
    getTransition: async () => 'none',
    getAnimations: async () => [],
    getShapeKeys: async () => [],
    getSlideLinks: async () => [],
    getRunLinks: async () => [],
    getNotes: async () => '',
    getComments: async () => [],
  }
  return new Proxy(implemented as SlidesApi, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (value !== undefined) return value
      if (typeof key === 'string' && key.startsWith('on')) return noListener
      if (typeof key === 'string') return () => unavailable(`Slides capability ${key}`)
      return undefined
    },
  })
}

export async function loadSlidesBrowserBootstrap(
  documentId: string,
  fetchBootstrap: typeof fetch = globalThis.fetch,
): Promise<SlidesBrowserBootstrap> {
  const response = await fetchBootstrap(`/api/documents/${encodeURIComponent(documentId)}/bootstrap`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Document bootstrap failed with HTTP ${String(response.status)}`)
  const value = (await response.json()) as Partial<SlidesBrowserBootstrap>
  if (
    typeof value.documentId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.websocketUrl !== 'string' ||
    typeof value.language !== 'string' ||
    typeof value.theme !== 'string' ||
    typeof value.contentVersion !== 'number' ||
    !Number.isSafeInteger(value.contentVersion) ||
    value.contentVersion < 1
  ) throw new Error('Local Host returned an invalid Slides bootstrap.')
  return value as SlidesBrowserBootstrap
}

export function createHttpSlidesBrowserTransport(
  bootstrap: SlidesBrowserBootstrap,
  fetchImpl: typeof fetch = globalThis.fetch,
): SlidesBrowserTransport {
  return {
    async execute(action, payload) {
      const response = await fetchImpl(`/api/documents/${encodeURIComponent(bootstrap.documentId)}/${action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as { message?: unknown; error?: unknown; code?: unknown }
        const error = new Error(typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : `Local Host request failed with HTTP ${String(response.status)}`) as Error & { code?: unknown }
        if (value.code !== undefined) error.code = value.code
        throw error
      }
      return response.json()
    },
  }
}

export function installSlidesBrowserHostApi(
  bootstrap: SlidesBrowserBootstrap,
  options: InstallSlidesBrowserHostOptions = {},
): SlidesBrowserHostHandle {
  const target = options.target ?? (window as unknown as SlidesBrowserHostTarget)
  const transport = options.transport ?? createHttpSlidesBrowserTransport(bootstrap)
  const client = options.client ?? createNexusClient({ url: bootstrap.websocketUrl })
  const bridge = createSlidesBrowserAgentBridge({
    client,
    documentId: bootstrap.documentId as DocumentId,
    revision: bootstrap.revision as Revision,
  })
  let slidesApi: SlidesApi
  let disposed = false
  const handle: SlidesBrowserHostHandle = {
    document: { documentId: bootstrap.documentId, title: bootstrap.title, revision: bootstrap.revision, contentVersion: bootstrap.contentVersion },
    settings: { language: bootstrap.language, theme: bootstrap.theme },
    get slidesApi() { return slidesApi },
    bridge,
    updateRevision(revision) { handle.document.revision = revision; bridge.updateRevision(revision as Revision) },
    updateContentVersion(contentVersion) { handle.document.contentVersion = contentVersion },
    dispose() {
      if (disposed) return
      disposed = true
      bridge.dispose()
      client.close()
      if (target.slidesApi === slidesApi) delete target.slidesApi
      if (target.agentApi === bridge.agentApi) delete target.agentApi
      if (target.nexusdeskSlidesHost === handle) delete target.nexusdeskSlidesHost
    },
  }
  slidesApi = createSlidesBrowserApi(handle, transport)
  bridge.attachEditor(createSlidesEditorAdapter({
    document: () => {
      const state = bridge.client()
      return {
        documentId: handle.document.documentId as DocumentId,
        clientId: (state.clientId ?? '') as ClientId,
        revision: handle.document.revision as Revision,
        contentVersion: handle.document.contentVersion,
        title: handle.document.title,
        attached: state.attached,
      }
    },
    read: async () => (await transport.execute('slides:read-presentation', {})) as JsonValue,
    runTransaction: async (operations) => {
      const result = await transport.execute('slides:apply-txn', { ops: operations }) as { applied: boolean; contentVersion?: number; records?: Array<{ op: string; target?: string }>; failures?: Array<{ error: string }> }
      if (result.applied && result.contentVersion !== undefined) handle.updateContentVersion(result.contentVersion)
      return result
    },
    save: async () => { await slidesApi.save() },
    async undo() {
      const result = await transport.execute('slides:undo', {}) as { contentVersion?: number } | null
      if (result?.contentVersion === undefined) return null
      handle.updateContentVersion(result.contentVersion)
      return { contentVersion: result.contentVersion }
    },
    async redo() {
      const result = await transport.execute('slides:redo', {}) as { contentVersion?: number } | null
      if (result?.contentVersion === undefined) return null
      handle.updateContentVersion(result.contentVersion)
      return { contentVersion: result.contentVersion }
    },
    consumeApproval: (approvalId, planHash) => bridge.consumeApproval(approvalId, planHash),
  }))
  target.slidesApi = slidesApi
  target.agentApi = bridge.agentApi
  target.nexusdeskSlidesHost = handle
  client.connect()
  return handle
}

export type SlidesHostSelection =
  | { kind: 'electron' }
  | { kind: 'local-web'; handle: SlidesBrowserHostHandle }
  | { kind: 'error'; message: string }

export async function selectSlidesHost(options: {
  search: string
  electronApi: SlidesApi | undefined
  installBrowser: (documentId: string) => Promise<SlidesBrowserHostHandle>
}): Promise<SlidesHostSelection> {
  const params = new URLSearchParams(options.search)
  if (params.get('host') === 'local-web') {
    const documentId = params.get('documentId')
    if (!documentId) return { kind: 'error', message: 'NexusDesk Slides could not start: local Web mode requires a document id.' }
    return { kind: 'local-web', handle: await options.installBrowser(documentId) }
  }
  return options.electronApi === undefined
    ? { kind: 'error', message: 'NexusDesk Slides could not start: the desktop bridge is unavailable.' }
    : { kind: 'electron' }
}

export async function installSlidesBrowserHostApiForDocument(documentId: string): Promise<SlidesBrowserHostHandle> {
  return installSlidesBrowserHostApi(await loadSlidesBrowserBootstrap(documentId))
}
