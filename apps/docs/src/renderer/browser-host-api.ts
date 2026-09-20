import { defaultAiSettings } from '@genoffice/ai-provider/browser'
import { DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import {
  workingCopyBootstrapSchema,
  type DocumentId,
  type EditorAdapter,
  type Revision,
  type WorkingCopyBootstrap,
  type PersistenceReference,
  type EditorRequestFrame,
} from '@nexusdesk/protocol'
import {
  createNexusClient,
  createBrowserWorkingCopyPersistence,
  createWorkingCopyMutationLane,
  type AgentApi,
  type NexusClient,
} from '@nexusdesk/web-client'
import { captureDocsWorkingCopy } from './agent/docs-working-copy'
import { docsSaveSnapshot } from './agent/docs-save-adapter'
import type { FileActionContext } from './file-actions'

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
  workingCopy?: WorkingCopyBootstrap
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
  readonly workingCopy?: WorkingCopyBootstrap
  attachEditor(
    adapter: EditorAdapter,
    capture?: { context(): FileActionContext; settle?(): void | Promise<void> },
  ): () => void
  setHydrated(): void
  runMutation<T>(task: () => Promise<T>): Promise<T>
  persistBytes?(bytes: Uint8Array, auto?: boolean): Promise<void>
  onOpenDocx: DesktopApi['onOpenDocx']
  onReadinessChanged(handler: (ready: boolean, error?: string) => void): () => void
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
  fetch?: typeof fetch
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
  if (value.workingCopy !== undefined)
    value.workingCopy = workingCopyBootstrapSchema.parse(value.workingCopy)
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
      const response = await fetchImpl(bootstrap.workingCopy?.contentUrl ?? bootstrap.contentUrl, {
        credentials: 'same-origin',
      })
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
  handle: Pick<
    DocsBrowserHostHandle,
    'document' | 'settings' | 'updateRevision' | 'workingCopy' | 'persistBytes' | 'onOpenDocx'
  >,
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
      const bytes = await transport.readContent()
      pending = false
      return {
        path: currentPath,
        name: handle.document.title,
        data: toArrayBuffer(bytes),
        hash: await sha256(bytes),
        ...(handle.workingCopy?.dirty ? { recovered: true } : {}),
      }
    },
    consumeNewBlankDoc: async () => false,
    consumeAiDocContent: async () => null,
    consumeHeadlessExport: async () => null,
    createDocument: () => unavailable('creating a separate native document'),
    onOpenDocx: handle.onOpenDocx,
    onRenamedDocx: noListener,
    async saveDocx(path, data, auto) {
      if (path !== currentPath) {
        return { ok: false, error: 'Web Docs can save only the Host-authorized document.' }
      }
      try {
        if (handle.persistBytes) {
          await handle.persistBytes(new Uint8Array(data), auto)
          return { ok: true }
        }
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
  let state = bootstrap.workingCopy ? { ...bootstrap.workingCopy } : undefined
  let hydrated = false
  let capture: { context(): FileActionContext; settle?(): void | Promise<void> } | undefined
  let activeSave: { frame: EditorRequestFrame; receipt?: PersistenceReference } | undefined
  let everRegistered = false
  let recoveryAttempts = 0
  let recoveryInFlight = false
  let initialHydrationSnapshot: string | undefined
  const openListeners = new Set<Parameters<DesktopApi['onOpenDocx']>[0]>()
  const readinessListeners = new Set<(ready: boolean, error?: string) => void>()
  const notifyReadiness = (error?: string) => {
    for (const listener of readinessListeners) listener(bridge.client().attached, error)
  }
  const lane = createWorkingCopyMutationLane()
  const persistence = state
    ? createBrowserWorkingCopyPersistence({
        documentId: bootstrap.documentId,
        origin: new URL(bootstrap.websocketUrl).origin.replace(/^ws/, 'http'),
        state: () => state ?? null,
        clientId: () => client.clientId,
        fetch: options.fetch,
      })
    : undefined
  const committed = (receipt: PersistenceReference) => {
    if (
      !state ||
      receipt.documentEpoch !== state.documentEpoch ||
      receipt.workingRevision < state.workingRevision
    )
      return
    state = {
      ...state,
      workingRevision: receipt.workingRevision,
      savedRevision: receipt.savedRevision,
      checkpointId: receipt.checkpointId,
      dirty: receipt.dirty,
    }
    document.revision = receipt.workingRevision
    if (hydrated) bridge.setHydrated(state)
  }
  const bridge = createDocsBrowserAgentBridge({
    client,
    documentId: bootstrap.documentId as DocumentId,
    revision: bootstrap.revision as Revision,
    ...(persistence
      ? ({
          workingCopy: {
            state: () => state ?? null,
            persistence,
            capture: () => {
              if (!capture) throw new Error('The document has not finished hydration.')
              return captureDocsWorkingCopy(capture.context, { settle: capture.settle })
            },
            run: lane.run,
            committed,
            async save(frame, action) {
              const saving: NonNullable<typeof activeSave> = { frame }
              activeSave = saving
              try {
                return { result: await action(), persistence: saving.receipt }
              } finally {
                activeSave = undefined
              }
            },
          },
        } satisfies Partial<Parameters<typeof createDocsBrowserAgentBridge>[0]>)
      : {}),
  })
  const document = {
    documentId: bootstrap.documentId,
    title: bootstrap.title,
    revision: state?.workingRevision ?? bootstrap.revision,
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
  const offReadiness = client.onState(() => notifyReadiness())
  const offRecovery = client.onFrame((frame) => {
    if (disposed || !state) return
    if (frame.type === 'editor:registered' && frame.documentId === bootstrap.documentId) {
      everRegistered ||= bridge.client().attached
      notifyReadiness()
    }
    if (frame.type !== 'recovery:required' || frame.documentId !== bootstrap.documentId) return
    notifyReadiness(`${frame.code}: ${frame.message}`)
    // Only replace a stale initial hydration automatically. After successful attachment,
    // preserve any new manual edits and show the recovery error instead of discarding them.
    if (
      frame.code !== 'REVISION_CONFLICT' ||
      everRegistered ||
      recoveryInFlight ||
      recoveryAttempts >= 3
    )
      return
    if (capture) {
      if (initialHydrationSnapshot === undefined) return
      try {
        if (docsSaveSnapshot(capture.context()) !== initialHydrationSnapshot) return
      } catch {
        return
      }
    }
    recoveryInFlight = true
    recoveryAttempts++
    hydrated = false
    bridge.setHydrated(null)
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, recoveryAttempts * 100))
      const next = await loadDocsBrowserBootstrap(
        bootstrap.documentId,
        options.fetch ?? globalThis.fetch,
      )
      if (!next.workingCopy) throw new Error('The Host omitted its working-copy recovery state.')
      const bytes = await createHttpDocsBrowserTransport(
        next,
        options.fetch ?? globalThis.fetch,
      ).readContent()
      if (disposed) return
      const hash = await sha256(bytes)
      state = { ...next.workingCopy }
      document.revision = state.workingRevision
      for (const listener of openListeners)
        listener({
          path: virtualPath(document.documentId),
          name: document.title,
          data: toArrayBuffer(bytes),
          hash,
          ...(state.dirty ? { recovered: true } : {}),
        })
    })()
      .catch((error) => notifyReadiness(errorMessage(error)))
      .finally(() => {
        recoveryInFlight = false
      })
  })
  const handle: DocsBrowserHostHandle = {
    document,
    capabilities,
    settings,
    bridge,
    get workingCopy() {
      return state
    },
    setHydrated() {
      if (!state || hydrated) return
      if (!everRegistered && capture) {
        try {
          initialHydrationSnapshot = docsSaveSnapshot(capture.context())
        } catch {
          initialHydrationSnapshot = undefined
        }
      }
      hydrated = true
      bridge.setHydrated(state)
    },
    runMutation: lane.run,
    onOpenDocx(handler) {
      openListeners.add(handler)
      return () => openListeners.delete(handler)
    },
    onReadinessChanged(handler) {
      readinessListeners.add(handler)
      handler(bridge.client().attached)
      return () => readinessListeners.delete(handler)
    },
    ...(persistence
      ? {
          async persistBytes(bytes: Uint8Array, auto?: boolean) {
            if (auto && !activeSave)
              throw new Error('Use Save to write the original document in Web Docs.')
            const payload = {
              kind: 'docx-bytes' as const,
              parts: new Map([['document', new Blob([new Uint8Array(bytes)])]]),
            }
            const receipt = activeSave
              ? await persistence.checkpoint(
                  activeSave.frame,
                  { ok: true, summary: 'Saved the current document.', warnings: [] },
                  payload,
                )
              : await persistence.saveManual('manual-save-' + crypto.randomUUID(), payload)
            if (activeSave) activeSave.receipt = receipt
            committed(receipt)
          },
        }
      : {}),
    get desktopApi() {
      return desktopApi
    },
    attachEditor(adapter, context) {
      capture = context
      const detach = bridge.attachEditor(adapter)
      return () => {
        detach()
        capture = undefined
        if (state) {
          hydrated = false
          bridge.setHydrated(null)
        }
      }
    },
    updateRevision(revision) {
      document.revision = revision
      bridge.updateRevision(revision as Revision)
    },
    dispose() {
      if (disposed) return
      disposed = true
      offReadiness()
      offRecovery()
      openListeners.clear()
      readinessListeners.clear()
      bridge.dispose()
      client.close()
      if (target.desktop === desktopApi) delete target.desktop
      if (target.agentApi === bridge.agentApi) delete target.agentApi
      if (target.nexusdeskDocsHost === handle) delete target.nexusdeskDocsHost
    },
  }
  const desktopApi = createDocsBrowserDesktopApi(handle, transport)
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
