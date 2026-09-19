import {
  HostError,
  fileListResponseSchema,
  hostErrorSchema,
  shellChangedEventSchema,
  shellBootstrapSchema,
  shellSettingsSchema,
  type HostCapabilities,
  type OfficeHost,
  type ShellBootstrap,
  type ShellSettings,
  type ShellSettingsPatch,
  type ShellTabSummary,
} from '@nexusdesk/office-host'
import { PROTOCOL_VERSION, type DocumentId } from '@nexusdesk/protocol'

export type WebFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface WebSocketConnection {
  addEventListener(type: 'message' | 'close', listener: (event: { data?: string }) => void): void
  close(): void
}

export type WebSocketFactory = (url: string) => WebSocketConnection

interface Parser<T> {
  parse(value: unknown): T
}

const BROWSER_CAPABILITIES: HostCapabilities = {
  mode: 'browser',
  editors: ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'],
  nativeFilePicker: false,
  browserImport: false,
  revealInFileManager: false,
  trash: false,
  updater: false,
  credentialStore: false,
}

export function createWebOfficeHost(
  fetcher: WebFetch = globalThis.fetch,
  socketFactory?: WebSocketFactory,
): OfficeHost {
  let current: ShellBootstrap | undefined
  let socket: WebSocketConnection | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let lastShellSequence = 0
  const tabListeners = new Set<(tabs: readonly ShellTabSummary[]) => void>()
  const settingsListeners = new Set<(settings: ShellSettings) => void>()

  function resolvedSocketFactory(): WebSocketFactory | undefined {
    if (socketFactory !== undefined) return socketFactory
    if (typeof globalThis.WebSocket === 'undefined' || typeof globalThis.location === 'undefined') {
      return undefined
    }
    return (url) => new globalThis.WebSocket(url) as WebSocketConnection
  }

  function socketUrl(): string {
    if (typeof globalThis.location === 'undefined') return '/ws'
    const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${globalThis.location.host}/ws`
  }

  function hasSubscribers(): boolean {
    return tabListeners.size > 0 || settingsListeners.size > 0
  }

  function ensureSocket(): void {
    if (socket !== undefined || !hasSubscribers()) return
    const factory = resolvedSocketFactory()
    if (factory === undefined) return
    const next = factory(socketUrl())
    socket = next
    next.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      try {
        const value: unknown = JSON.parse(event.data)
        if (
          typeof value === 'object' &&
          value !== null &&
          (value as Record<string, unknown>).type === 'server:ready' &&
          (value as Record<string, unknown>).protocolVersion === PROTOCOL_VERSION
        ) {
          void bootstrap().catch(() => {})
          return
        }
        const parsed = shellChangedEventSchema.safeParse(value)
        if (!parsed.success || parsed.data.sequence <= lastShellSequence) return
        const shellEvent = parsed.data
        lastShellSequence = shellEvent.sequence
        void bootstrap().catch(() => {})
      } catch {
        // Ignore unrelated or malformed frames; editor/Agent frames share this transport.
      }
    })
    next.addEventListener('close', () => {
      if (socket !== next) return
      socket = undefined
      if (!hasSubscribers()) return
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        ensureSocket()
      }, 500)
    })
  }

  function closeSocketWithoutSubscribers(): void {
    if (hasSubscribers()) return
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    socket?.close()
    socket = undefined
  }

  async function request<T>(
    path: string,
    schema: Parser<T>,
    init?: Omit<RequestInit, 'credentials'>,
  ): Promise<T> {
    const response = await fetcher(path, { ...init, credentials: 'same-origin' })
    const value: unknown = await response.json()
    if (!response.ok) {
      const parsed = hostErrorSchema.safeParse(value)
      if (parsed.success) {
        throw new HostError(
          parsed.data.code,
          parsed.data.message,
          parsed.data.retryable,
          parsed.data.documentId,
        )
      }
      throw new HostError(
        'INTERNAL_ERROR',
        `Local Host request failed with HTTP ${String(response.status)}.`,
        response.status >= 500,
      )
    }
    return schema.parse(value)
  }

  function acceptBootstrap(next: ShellBootstrap): ShellBootstrap {
    current = next
    for (const listener of tabListeners) listener(next.tabs)
    for (const listener of settingsListeners) listener(next.settings)
    return next
  }

  async function bootstrap(): Promise<ShellBootstrap> {
    return acceptBootstrap(await request('/api/shell/bootstrap', shellBootstrapSchema))
  }

  async function mutate(path: string, body: unknown): Promise<ShellBootstrap> {
    return acceptBootstrap(
      await request(path, shellBootstrapSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  async function ensuredBootstrap(): Promise<ShellBootstrap> {
    return current ?? bootstrap()
  }

  return {
    capabilities: BROWSER_CAPABILITIES,
    bootstrap,
    files: {
      async list() {
        return (await request('/api/shell/files', fileListResponseSchema)).files
      },
      open(fileId) {
        return mutate('/api/shell/files/open', { fileId })
      },
      async toggleStar(fileId) {
        return (
          await request('/api/shell/files/toggle-star', fileListResponseSchema, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId }),
          })
        ).files
      },
    },
    documents: {
      async list() {
        return (await ensuredBootstrap()).documents
      },
      async save(documentId) {
        throw new HostError(
          'UNSUPPORTED_CAPABILITY',
          `Saving document ${documentId} is owned by the active Web editor and its Agent save tool.`,
          false,
          documentId,
        )
      },
      async close(documentId) {
        return mutate('/api/shell/tabs/close', { tabId: `document:${documentId}` })
      },
    },
    tabs: {
      async list() {
        return (await ensuredBootstrap()).tabs
      },
      activate(tabId) {
        return mutate('/api/shell/tabs/activate', { tabId })
      },
      close(tabId) {
        return mutate('/api/shell/tabs/close', { tabId })
      },
      reorder(tabId, toIndex) {
        return mutate('/api/shell/tabs/reorder', { tabId, toIndex })
      },
      onChanged(listener) {
        tabListeners.add(listener)
        ensureSocket()
        return () => {
          tabListeners.delete(listener)
          closeSocketWithoutSubscribers()
        }
      },
    },
    settings: {
      get() {
        return request('/api/shell/settings', shellSettingsSchema)
      },
      async update(patch: ShellSettingsPatch) {
        const settings = await request('/api/shell/settings', shellSettingsSchema, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (current !== undefined) current = { ...current, settings }
        for (const listener of settingsListeners) listener(settings)
        return settings
      },
      onChanged(listener) {
        settingsListeners.add(listener)
        ensureSocket()
        return () => {
          settingsListeners.delete(listener)
          closeSocketWithoutSubscribers()
        }
      },
    },
    agent: {
      start(_documentId: DocumentId, _prompt: string) {
        return Promise.reject(
          new HostError(
            'UNSUPPORTED_CAPABILITY',
            'Agent sessions are owned by the active editor in this milestone.',
            false,
          ),
        )
      },
      cancel(_documentId: DocumentId) {
        return Promise.reject(
          new HostError(
            'UNSUPPORTED_CAPABILITY',
            'Agent sessions are owned by the active editor in this milestone.',
            false,
          ),
        )
      },
    },
    platform: {
      browse() {
        return Promise.reject(
          new HostError(
            'UNSUPPORTED_CAPABILITY',
            'Browser file import is not enabled in this build.',
            false,
          ),
        )
      },
      revealFile(_fileId: string) {
        return Promise.reject(
          new HostError(
            'UNSUPPORTED_CAPABILITY',
            'Reveal in file manager is unavailable in browser mode.',
            false,
          ),
        )
      },
      trashFiles(_fileIds: readonly string[]) {
        return Promise.reject(
          new HostError('UNSUPPORTED_CAPABILITY', 'Trash is unavailable in browser mode.', false),
        )
      },
    },
  }
}
