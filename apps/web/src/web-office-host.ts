import {
  HostError,
  fileListResponseSchema,
  hostErrorSchema,
  shellBootstrapSchema,
  shellSettingsSchema,
  type HostCapabilities,
  type OfficeHost,
  type ShellBootstrap,
  type ShellSettings,
  type ShellSettingsPatch,
  type ShellTabSummary,
} from '@nexusdesk/office-host'
import { parseAgentToolResult, type DocumentId } from '@nexusdesk/protocol'

export type WebFetch = (input: string, init?: RequestInit) => Promise<Response>

interface Parser<T> {
  parse(value: unknown): T
}

const agentToolResultParser = {
  parse: parseAgentToolResult,
}

const BROWSER_CAPABILITIES: HostCapabilities = {
  mode: 'browser',
  editors: ['sheets'],
  nativeFilePicker: false,
  browserImport: false,
  revealInFileManager: false,
  trash: false,
  updater: false,
  credentialStore: false,
}

function unsupported(message: string): never {
  throw new HostError('UNSUPPORTED_CAPABILITY', message, false)
}

export function createWebOfficeHost(fetcher: WebFetch = globalThis.fetch): OfficeHost {
  let current: ShellBootstrap | undefined
  const tabListeners = new Set<(tabs: readonly ShellTabSummary[]) => void>()
  const settingsListeners = new Set<(settings: ShellSettings) => void>()

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
        await request(
          `/api/documents/${encodeURIComponent(documentId)}/save`,
          agentToolResultParser,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
        )
        const next = await bootstrap()
        const document = next.documents.find((candidate) => candidate.documentId === documentId)
        if (document === undefined) {
          throw new HostError('DOCUMENT_NOT_FOUND', `Document does not exist: ${documentId}`, false)
        }
        return document
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
        return () => tabListeners.delete(listener)
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
        return () => settingsListeners.delete(listener)
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
