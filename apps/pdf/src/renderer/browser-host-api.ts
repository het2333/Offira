import { defaultAiSettings } from '@genoffice/ai-provider/browser'
import { DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import type {
  DocumentId,
  Revision,
  WorkingCopyBootstrap,
  PersistenceReference,
} from '@nexusdesk/protocol'
import { assertPdfWebPayload, workingCopyBootstrapSchema } from '@nexusdesk/protocol'
import type { PdfCapabilities, PdfPageModification } from '../shared/web-capabilities'
import {
  createNexusClient,
  createBrowserWorkingCopyPersistence,
  createWorkingCopyMutationLane,
  type AgentApi,
  type NexusClient,
} from '@nexusdesk/web-client'
import { capturePdfWorkingCopy } from './agent/pdf-working-copy'

import type {
  ImageEditFailure,
  PageImageRef,
  PdfApi,
  SavePdfRequest,
  TextEditFailure,
  TextInsertFailure,
  StaticFormFillRecord,
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
  workingCopy?: WorkingCopyBootstrap
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
  listStaticFormFills?(): Promise<StaticFormFillRecord[]>
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
  saveWorkingCopy?(request: SavePdfRequest, modification?: PdfPageModification): Promise<void>
  readonly reloadError?: string
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
  if (value.workingCopy !== undefined)
    value.workingCopy = workingCopyBootstrapSchema.parse(value.workingCopy)
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
    async listStaticFormFills() {
      const value = (await post(
        'list-static-form-fills',
        bootstrap.workingCopy ? { sourceContentId: bootstrap.workingCopy.sourceContentId } : {},
      )) as { fills?: StaticFormFillRecord[] }
      if (!Array.isArray(value.fills)) throw new Error('Invalid PDF static form data')
      return value.fills
    },
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
      const value = (await post('page-image-png', {
        ...request,
        ...(bootstrap.workingCopy
          ? { sourceContentId: bootstrap.workingCopy.sourceContentId }
          : {}),
      })) as { png: unknown }
      if (value.png !== null && typeof value.png !== 'string')
        throw new Error('Invalid PDF image preview')
      return value.png
    },
    async readContent() {
      const response = await fetchImpl(bootstrap.workingCopy?.contentUrl ?? bootstrap.contentUrl, {
        credentials: 'same-origin',
      })
      if (!response.ok) throw await hostError(response)
      return new Uint8Array(await response.arrayBuffer())
    },
    async listPageImages() {
      const response = await fetchImpl(
        `/api/documents/${encodeURIComponent(bootstrap.documentId)}/list-page-images`,
        {
          method: 'POST',
          credentials: 'same-origin',
          ...(bootstrap.workingCopy
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceContentId: bootstrap.workingCopy.sourceContentId }),
              }
            : {}),
        },
      )
      if (!response.ok) throw await hostError(response)
      const value = (await response.json()) as { images?: unknown }
      if (!Array.isArray(value.images))
        throw new Error('Local Host returned invalid PDF image data')
      return value.images as PageImageRef[]
    },
    async save(request, expectedRevision) {
      assertPdfWebPayload({ request, expectedRevision })
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
      if (state.saveWorkingCopy) {
        await state.saveWorkingCopy(
          { path, markups: [], drawings: [], formValues: [], stamps: [] },
          modification,
        )
        return { ok: true as const }
      }
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
      if (state.reloadError) throw new Error(state.reloadError)
      return toArrayBuffer(await transport.readContent())
    },
    async save(request) {
      if (request.path !== path || request.targetPath !== undefined) {
        return { ok: false, error: 'Web PDF can save only the Host-authorized document.' }
      }
      try {
        if (state.saveWorkingCopy) {
          await state.saveWorkingCopy(request)
          return { ok: true }
        }
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
    listStaticFormFills: () => transport.listStaticFormFills?.() ?? Promise.resolve([]),
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
  readonly recoveryDirty: boolean
  readonly hydrated: boolean
  readonly busy: boolean
  readonly reloadError: string | undefined
  setHydrated(sourceContentId?: string): void
  rebase(): Promise<void>
  onWorkingCopyState(listener: () => void): () => void
  runMutation<T>(task: () => Promise<T>): Promise<T>
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
  fetch?: typeof fetch
}

export function installPdfBrowserHostApi(
  bootstrap: PdfBrowserBootstrap,
  options: InstallPdfBrowserHostOptions = {},
): PdfBrowserHostHandle {
  const target = options.target ?? (window as unknown as PdfBrowserHostTarget)
  const client = options.client ?? createNexusClient({ url: bootstrap.websocketUrl })
  const lane = createWorkingCopyMutationLane()
  let recoveryDirty = bootstrap.workingCopy?.dirty ?? false
  let hydrated = !bootstrap.workingCopy
  let rebasing = false
  let busy = false
  let reloadError: string | undefined
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of listeners) listener()
  }
  const runMutation = <T>(task: () => Promise<T>): Promise<T> =>
    lane.run(async () => {
      busy = true
      publish()
      try {
        return await task()
      } finally {
        busy = false
        publish()
      }
    })
  const persistence = bootstrap.workingCopy
    ? createBrowserWorkingCopyPersistence({
        documentId: bootstrap.documentId,
        origin: '',
        state: () => (hydrated ? (bootstrap.workingCopy ?? null) : null),
        clientId: () => client.clientId,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : undefined
  const didPersist = (receipt: PersistenceReference) => {
    if (!bootstrap.workingCopy || receipt.workingRevision < bootstrap.workingCopy.workingRevision)
      return
    bootstrap.workingCopy = {
      ...bootstrap.workingCopy,
      workingRevision: receipt.workingRevision,
      savedRevision: receipt.savedRevision,
      checkpointId: receipt.checkpointId,
      dirty: receipt.dirty,
    }
    bootstrap.revision = receipt.workingRevision
    recoveryDirty = true
    publish()
  }
  const bridge = createPdfBrowserAgentBridge({
    client,
    documentId: bootstrap.documentId as DocumentId,
    revision: bootstrap.revision as Revision,
    ...(persistence
      ? {
          workingCopy: {
            state: () => bootstrap.workingCopy ?? null,
            persistence,
            didPersist,
            run: runMutation,
          },
        }
      : {}),
  })
  let disposed = false
  let currentAdapter: PdfEditorAdapter | undefined
  let recoveryAttempts = 0
  let recovering = false
  let recoveryRequested = false
  const recover = () => {
    if (disposed || recovering || !recoveryRequested || !currentAdapter?.restoreWorkingCopy) return
    const restore = currentAdapter.restoreWorkingCopy
    recovering = true
    void runMutation(async () => {
      while (!disposed && recoveryRequested && recoveryAttempts < 3) {
        recoveryAttempts++
        try {
          await handle.rebase()
          await restore()
          recoveryRequested = false
          return
        } catch {
          /* A bounded bootstrap/load retry leaves its source gated. */
        }
      }
      hydrated = false
      reloadError = 'PDF recovery could not load the current source. Refresh to retry.'
      bridge.setHydrated(null)
      publish()
    }).finally(() => {
      recovering = false
    })
  }
  const unsubscribeRecovery = client.onFrame((frame) => {
    if (
      !bootstrap.workingCopy ||
      !('documentId' in frame) ||
      frame.documentId !== bootstrap.documentId
    )
      return
    if (
      frame.type === 'editor:registered' &&
      frame.sourceContentId === bootstrap.workingCopy.sourceContentId &&
      frame.revision === bootstrap.workingCopy.workingRevision
    ) {
      recoveryAttempts = 0
      publish()
    }
    if (frame.type === 'recovery:required') {
      hydrated = false
      bridge.setHydrated(null)
      recoveryRequested = true
      publish()
      recover()
    }
  })
  const handle: PdfBrowserHostHandle = {
    document: bootstrap,
    capabilities: bootstrap.capabilities,
    pdfApi: undefined as never,
    bridge,
    get recoveryDirty() {
      return recoveryDirty
    },
    get hydrated() {
      return hydrated
    },
    get busy() {
      return busy || (!!bootstrap.workingCopy && (!hydrated || !bridge.client().attached))
    },
    get reloadError() {
      return reloadError
    },
    runMutation,
    onWorkingCopyState(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setHydrated(sourceContentId) {
      if (
        hydrated ||
        reloadError ||
        rebasing ||
        sourceContentId !== bootstrap.workingCopy?.sourceContentId
      )
        return
      hydrated = true
      recoveryDirty = bootstrap.workingCopy?.dirty ?? false
      bridge.setHydrated(bootstrap.workingCopy ?? null)
      publish()
    },
    async rebase() {
      if (!bootstrap.workingCopy) return
      hydrated = false
      rebasing = true
      bridge.setHydrated(null)
      publish()
      try {
        const next = await loadPdfBrowserBootstrap(bootstrap.documentId, options.fetch)
        Object.assign(bootstrap, next)
        reloadError = undefined
      } catch (error) {
        reloadError = error instanceof Error ? error.message : 'PDF saved; reload failed'
        throw error
      } finally {
        rebasing = false
      }
    },
    attachEditor(adapter) {
      currentAdapter = adapter
      const detach = bridge.attachEditor(adapter)
      recover()
      return () => {
        if (currentAdapter === adapter) currentAdapter = undefined
        detach()
      }
    },
    updateRevision(revision) {
      bootstrap.revision = revision
      bridge.updateRevision(revision as Revision)
    },
    dispose() {
      if (disposed) return
      disposed = true
      bridge.dispose()
      unsubscribeRecovery()
      listeners.clear()
      client.close()
      if (target.pdfApi === handle.pdfApi) delete target.pdfApi
      if (target.agentApi === bridge.agentApi) delete target.agentApi
      if (target.nexusdeskPdfHost === handle) delete target.nexusdeskPdfHost
    },
  }
  const pdfApi = createPdfBrowserApi(
    {
      document: bootstrap,
      updateRevision: handle.updateRevision,
      get reloadError() {
        return reloadError
      },
      ...(persistence
        ? {
            saveWorkingCopy: async (
              request: SavePdfRequest,
              modification?: PdfPageModification,
            ) => {
              await runMutation(async () => {
                assertPdfWebPayload({ request, expectedRevision: bootstrap.revision })
                const receipt = await persistence.saveManual(
                  'pdf-save-' + crypto.randomUUID(),
                  capturePdfWorkingCopy(request, modification),
                )
                didPersist(receipt)
                try {
                  await handle.rebase()
                } catch {
                  /* The durable save succeeded; readFile reports the separate reload failure. */
                }
              })
            },
          }
        : {}),
    },
    options.transport ?? createHttpPdfBrowserTransport(bootstrap, options.fetch),
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
