import { defaultAiSettings } from '@genoffice/ai-provider/browser'
import { DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import {
  workingCopyBootstrapSchema,
  type DocumentId,
  type EditorAdapter,
  type Revision,
  type WorkingCopyBootstrap,
  type PersistenceReference,
} from '@nexusdesk/protocol'
import {
  createNexusClient,
  createBrowserWorkingCopyPersistence,
  createWorkingCopyMutationLane,
  type AgentApi,
  type NexusClient,
} from '@nexusdesk/web-client'

import { createBrowserAgentBridge, type BrowserAgentBridge } from './agent/browser-agent-api'
import type { DesktopApi, UiTheme, WorkbookFile } from '../shared/desktop-api'
import {
  assertWorkingCopyOperationsPersistable,
  buildWorkingCopyPayload,
} from './working-copy-payload'
import type { SaveContext, SaveOutcome } from './save-actions'
import { lockApprovedSave } from './approved-save-lock'
import { aiBulkUndoGate } from './univer-state'

export interface BrowserHostBootstrap {
  documentId: DocumentId
  title: string
  revision: Revision
  websocketUrl: string
  language: Awaited<ReturnType<DesktopApi['getLanguage']>>
  theme: UiTheme
  workbook: WorkbookFile
  workingCopy?: WorkingCopyBootstrap
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
  fetch?: typeof fetch
}

export async function loadBrowserHostBootstrap(
  documentId: string,
  fetchBootstrap: typeof fetch = globalThis.fetch,
): Promise<BrowserHostBootstrap> {
  const response = await fetchBootstrap(
    `/api/documents/${encodeURIComponent(documentId)}/bootstrap`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
    throw Object.assign(
      new Error(error.message ?? `Document bootstrap failed with HTTP ${String(response.status)}`),
      { code: error.code },
    )
  }
  const value = (await response.json()) as Partial<BrowserHostBootstrap>
  if (
    typeof value.documentId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.websocketUrl !== 'string' ||
    value.workbook === undefined
  ) {
    throw new Error('Local Host returned an invalid document bootstrap')
  }
  if (value.workingCopy) {
    value.workingCopy = workingCopyBootstrapSchema.parse(value.workingCopy)
    if (value.workbook.sha256 !== value.workingCopy.sourceContentId)
      throw new Error('Workbook session and hydration source do not match.')
  }
  return value as BrowserHostBootstrap
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
    saveWorkbookEdits: (request) =>
      bootstrap.workingCopy
        ? unavailable('legacy save-workbook; use the working-copy save lane')
        : transport.request('save-workbook', request),
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
      const value = (await response.json()) as unknown
      if (!response.ok) {
        const message =
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { error?: unknown }).error === 'string'
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
  readonly hasWorkingCopy: boolean
  configureSaveContext(context: () => SaveContext): void
  markHydrated(sessionId: string): void
  saveWorkingCopy(context: SaveContext): Promise<SaveOutcome>
  dispose(): void
}

export function installBrowserHostApi(
  bootstrap: BrowserHostBootstrap,
  options: InstallBrowserHostOptions = {},
): BrowserHostHandle {
  const target = options.target ?? (window as unknown as BrowserHostTarget)
  const client = options.client ?? createNexusClient({ url: bootstrap.websocketUrl })
  const transport = options.transport ?? createHttpBrowserHostTransport(bootstrap.documentId)
  let currentBootstrap = bootstrap
  let current = bootstrap.workingCopy ?? null
  let context: (() => SaveContext) | undefined
  let hydrated = false
  let attached = false
  const lane = createWorkingCopyMutationLane()
  const capture = () => {
    if (!context) throw new Error('Workbook capture is not ready.')
    if (aiBulkUndoGate.active) throw new Error('The workbook is still applying edits.')
    return buildWorkingCopyPayload(context())
  }
  const persistence = createBrowserWorkingCopyPersistence({
    documentId: bootstrap.documentId,
    origin: '',
    state: () => current,
    clientId: () => client.clientId,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const committed = (receipt: PersistenceReference) => {
    if (!current || receipt.workingRevision < current.workingRevision) return
    current = {
      ...current,
      checkpointId: receipt.checkpointId,
      workingRevision: receipt.workingRevision,
      savedRevision: receipt.savedRevision,
      dirty: receipt.dirty,
    }
    document.revision = receipt.workingRevision as Revision
    if (hydrated && attached) bridge.setHydrated(current)
  }
  const reopen = async () => {
    hydrated = false
    bridge.setHydrated(null)
    currentBootstrap = await loadBrowserHostBootstrap(bootstrap.documentId, options.fetch)
    current = currentBootstrap.workingCopy ?? null
    if (!current || !context) throw new Error('The saved workbook could not be hydrated.')
    document.revision = current.workingRevision as Revision
    await context().openLazyWorkbook(currentBootstrap.workbook)
    if (!hydrated) throw new Error('Workbook installation did not confirm hydration.')
  }
  const bridge = createBrowserAgentBridge({
    client,
    documentId: bootstrap.documentId,
    revision: bootstrap.revision,
    ...(current
      ? {
          workingCopy: {
            state: () => current,
            persistence,
            capture,
            preflight: (operations) => {
              if (!context) throw new Error('The workbook is not ready.')
              assertWorkingCopyOperationsPersistable(context(), operations)
            },
            lane,
            lock: () => lockApprovedSave(context?.().univerRef.current ?? null),
            committed,
            afterSave: reopen,
            failed: () => {
              hydrated = false
              bridge.setHydrated(null)
            },
          },
        }
      : {}),
  })
  const desktopApi = createBrowserDesktopApi(bootstrap, transport)
  const document = {
    documentId: bootstrap.documentId,
    title: bootstrap.title,
    revision: (current?.workingRevision ?? bootstrap.revision) as Revision,
  }
  let disposed = false
  let recovering: Promise<void> | undefined
  let recoveryAttempts = 0
  const offRecovery = client.onFrame((frame) => {
    if (
      !bootstrap.workingCopy ||
      disposed ||
      (frame.type !== 'editor:registered' && frame.type !== 'recovery:required') ||
      frame.documentId !== bootstrap.documentId
    )
      return
    if (frame.type === 'editor:registered') {
      recoveryAttempts = 0
      return
    }
    if (frame.type !== 'recovery:required') return
    hydrated = false
    bridge.setHydrated(null)
    if (recovering) return
    recovering = lane
      .run(async () => {
        const release = lockApprovedSave(context?.().univerRef.current ?? null)
        try {
          let lastError = frame.message
          while (!disposed && recoveryAttempts < 3) {
            recoveryAttempts++
            try {
              await reopen()
              return
            } catch (error) {
              lastError = error instanceof Error ? error.message : String(error)
            }
          }
          context?.().setMessage('Workbook recovery failed: ' + lastError + '. Reload to retry.')
        } finally {
          release()
        }
      })
      .finally(() => {
        recovering = undefined
      })
  })
  const handle: BrowserHostHandle = {
    document,
    bridge,
    hasWorkingCopy: !!bootstrap.workingCopy,
    configureSaveContext(next) {
      context = next
    },
    markHydrated(sessionId) {
      if (!current || sessionId !== currentBootstrap.workbook.sessionId) return
      bridge.setEditorSessionId(sessionId)
      hydrated = true
      if (attached) bridge.setHydrated(current)
    },
    saveWorkingCopy(ctx) {
      return lane.run(async () => {
        if (!current || !hydrated || aiBulkUndoGate.active)
          return { ok: false, error: 'The workbook is not ready to save.' }
        let saved = false
        const release = lockApprovedSave(ctx.univerRef.current)
        try {
          const payload = await buildWorkingCopyPayload(ctx)
          if (ctx.approvedSaveGuard?.() === false)
            throw new Error('STALE_CONTENT: the workbook changed after approval.')
          const receipt = await persistence.saveManual(crypto.randomUUID(), payload)
          saved = true
          committed(receipt)
          await reopen()
          ctx.setMessage('Saved the current workbook.')
          return {
            ok: true,
            ...(ctx.lazyWorkbookRef.current?.file.path
              ? { path: ctx.lazyWorkbookRef.current.file.path }
              : {}),
          }
        } catch (error) {
          hydrated = false
          bridge.setHydrated(null)
          const message = saved
            ? 'The workbook was saved, but reopening failed. Reload to continue.'
            : error instanceof Error
              ? error.message
              : 'Workbook save failed.'
          ctx.setMessage(message)
          return { ok: saved, error: message }
        } finally {
          release()
        }
      })
    },
    attachEditor(adapter) {
      attached = true
      bridge.attachEditor(adapter)
      if (hydrated && current) bridge.setHydrated(current)
    },
    updateRevision(revision) {
      if (bootstrap.workingCopy) return
      document.revision = revision
      bridge.updateRevision(revision)
    },
    dispose() {
      if (disposed) return
      disposed = true
      bridge.dispose()
      offRecovery()
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
