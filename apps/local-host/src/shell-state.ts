import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  HostError,
  shellBootstrapSchema,
  shellSettingsPatchSchema,
  type HostCapabilities,
  type ShellBootstrap,
  type ShellDocumentSummary,
  type ShellSettings,
  type ShellSettingsPatch,
  type ShellTabSummary,
} from '@nexusdesk/office-host'

const DEFAULT_CAPABILITIES: HostCapabilities = {
  mode: 'browser',
  editors: ['sheets'],
  nativeFilePicker: false,
  browserImport: false,
  revealInFileManager: false,
  trash: false,
  updater: false,
  credentialStore: false,
}

const DEFAULT_SETTINGS: ShellSettings = {
  language: 'zh',
  theme: 'system',
  onboardingSeen: true,
}

function mergeSettings(base: ShellSettings, patch: ShellSettingsPatch): ShellSettings {
  return {
    language: patch.language ?? base.language,
    theme: patch.theme ?? base.theme,
    onboardingSeen: patch.onboardingSeen ?? base.onboardingSeen,
  }
}

interface PersistedShellState {
  readonly tabDocumentIds: readonly string[]
  readonly closedDocumentIds: readonly string[]
  readonly activeTabId: string
  readonly settings: ShellSettings
}

export interface ShellStateOptions {
  readonly path: string
  readonly documents: readonly ShellDocumentSummary[]
  readonly capabilities?: HostCapabilities
}

function defaultPersistedState(documents: readonly ShellDocumentSummary[]): PersistedShellState {
  return {
    tabDocumentIds: documents.map((document) => document.documentId),
    closedDocumentIds: [],
    activeTabId: 'home',
    settings: DEFAULT_SETTINGS,
  }
}

async function readPersistedState(
  path: string,
  documents: readonly ShellDocumentSummary[],
): Promise<PersistedShellState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<PersistedShellState>
    if (
      !Array.isArray(value.tabDocumentIds) ||
      !Array.isArray(value.closedDocumentIds) ||
      typeof value.activeTabId !== 'string'
    ) {
      return defaultPersistedState(documents)
    }
    const settings = shellSettingsPatchSchema.parse(value.settings ?? {})
    return {
      tabDocumentIds: value.tabDocumentIds.filter((id): id is string => typeof id === 'string'),
      closedDocumentIds: value.closedDocumentIds.filter(
        (id): id is string => typeof id === 'string',
      ),
      activeTabId: value.activeTabId,
      settings: mergeSettings(DEFAULT_SETTINGS, settings),
    }
  } catch {
    return defaultPersistedState(documents)
  }
}

async function writeAtomic(path: string, value: PersistedShellState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  const handle = await open(temporaryPath, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporaryPath, path)
}

export class ShellState {
  private readonly documentsById: Map<string, ShellDocumentSummary>

  private constructor(
    private readonly path: string,
    documents: readonly ShellDocumentSummary[],
    private readonly capabilities: HostCapabilities,
    private state: PersistedShellState,
  ) {
    this.documentsById = new Map(
      documents.map((document) => [document.documentId, document] as const),
    )
    this.reconcileDocuments()
  }

  static async open(options: ShellStateOptions): Promise<ShellState> {
    return new ShellState(
      options.path,
      options.documents,
      options.capabilities ?? DEFAULT_CAPABILITIES,
      await readPersistedState(options.path, options.documents),
    )
  }

  bootstrap(capabilities: HostCapabilities = this.capabilities): ShellBootstrap {
    const tabs = this.tabs()
    const activeTabId = tabs.some((tab) => tab.id === this.state.activeTabId)
      ? this.state.activeTabId
      : 'home'
    return shellBootstrapSchema.parse({
      capabilities,
      documents: [...this.documentsById.values()],
      tabs: tabs.map((tab) => ({ ...tab, active: tab.id === activeTabId })),
      settings: this.state.settings,
    })
  }

  async activate(tabId: string): Promise<ShellBootstrap> {
    if (!this.tabs().some((tab) => tab.id === tabId)) {
      throw new HostError('TAB_NOT_FOUND', `Tab does not exist: ${tabId}`, false)
    }
    this.state = { ...this.state, activeTabId: tabId }
    await this.persist()
    return this.bootstrap()
  }

  async close(tabId: string): Promise<ShellBootstrap> {
    if (tabId === 'home') throw new HostError('INVALID_REQUEST', 'Home cannot be closed.', false)
    const documentId = tabId.startsWith('document:') ? tabId.slice('document:'.length) : undefined
    if (documentId === undefined || !this.state.tabDocumentIds.includes(documentId)) {
      throw new HostError('TAB_NOT_FOUND', `Tab does not exist: ${tabId}`, false)
    }
    this.state = {
      ...this.state,
      tabDocumentIds: this.state.tabDocumentIds.filter((id) => id !== documentId),
      closedDocumentIds: [...new Set([...this.state.closedDocumentIds, documentId])],
      activeTabId: this.state.activeTabId === tabId ? 'home' : this.state.activeTabId,
    }
    await this.persist()
    return this.bootstrap()
  }

  async openDocument(documentId: string): Promise<ShellBootstrap> {
    if (!this.documentsById.has(documentId)) {
      throw new HostError('DOCUMENT_NOT_FOUND', `Document does not exist: ${documentId}`, false)
    }
    const tabDocumentIds = this.state.tabDocumentIds.includes(documentId)
      ? this.state.tabDocumentIds
      : [...this.state.tabDocumentIds, documentId]
    this.state = {
      ...this.state,
      tabDocumentIds,
      closedDocumentIds: this.state.closedDocumentIds.filter((id) => id !== documentId),
      activeTabId: `document:${documentId}`,
    }
    await this.persist()
    return this.bootstrap()
  }

  async reorder(tabId: string, toIndex: number): Promise<ShellBootstrap> {
    if (tabId === 'home') throw new HostError('INVALID_REQUEST', 'Home stays pinned first.', false)
    const documentId = tabId.startsWith('document:') ? tabId.slice('document:'.length) : undefined
    const fromIndex = documentId === undefined ? -1 : this.state.tabDocumentIds.indexOf(documentId)
    if (fromIndex < 0) throw new HostError('TAB_NOT_FOUND', `Tab does not exist: ${tabId}`, false)
    const next = [...this.state.tabDocumentIds]
    next.splice(fromIndex, 1)
    const destination = Math.max(0, Math.min(toIndex - 1, next.length))
    next.splice(destination, 0, documentId!)
    this.state = { ...this.state, tabDocumentIds: next }
    await this.persist()
    return this.bootstrap()
  }

  async updateSettings(patch: ShellSettingsPatch): Promise<ShellBootstrap> {
    const parsed = shellSettingsPatchSchema.parse(patch)
    this.state = { ...this.state, settings: mergeSettings(this.state.settings, parsed) }
    await this.persist()
    return this.bootstrap()
  }

  private tabs(): ShellTabSummary[] {
    const tabs: ShellTabSummary[] = [
      { id: 'home', kind: 'home', title: 'Home', closable: false, active: false },
    ]
    for (const documentId of this.state.tabDocumentIds) {
      const document = this.documentsById.get(documentId)
      if (document === undefined) continue
      tabs.push({
        id: `document:${document.documentId}`,
        kind: document.editorType,
        title: document.title,
        closable: true,
        active: false,
        documentId: document.documentId,
      })
    }
    return tabs
  }

  private reconcileDocuments(): void {
    const authorized = new Set(this.documentsById.keys())
    const closed = new Set(this.state.closedDocumentIds.filter((id) => authorized.has(id)))
    const ordered = this.state.tabDocumentIds.filter((id) => authorized.has(id) && !closed.has(id))
    for (const documentId of authorized) {
      if (!ordered.includes(documentId) && !closed.has(documentId)) ordered.push(documentId)
    }
    this.state = {
      ...this.state,
      tabDocumentIds: ordered,
      closedDocumentIds: [...closed],
      activeTabId:
        this.state.activeTabId === 'home' ||
        ordered.some((id) => `document:${id}` === this.state.activeTabId)
          ? this.state.activeTabId
          : 'home',
    }
  }

  private persist(): Promise<void> {
    return writeAtomic(this.path, this.state)
  }
}
