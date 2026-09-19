import {
  HostError,
  type EditorKind,
  type FileSummary,
  type OfficeHost,
  type ShellBootstrap,
  type ShellDocumentSummary,
  type ShellSettings,
  type ShellTabSummary,
} from '@nexusdesk/office-host'
import type { DocumentId, Revision } from '@nexusdesk/protocol'

import type { HomeApi, RecentEntry } from '../../shared/home-api'
import type { TabSummary, TabsApi } from '../../shared/tabs-api'

function editorKind(entry: Pick<RecentEntry, 'ext'>): EditorKind {
  if (entry.ext === 'docx') return 'docs'
  if (entry.ext === 'xlsx' || entry.ext === 'xlsm' || entry.ext === 'xls' || entry.ext === 'csv') {
    return 'sheets'
  }
  if (entry.ext === 'pptx') return 'slides'
  if (entry.ext === 'pdf') return 'pdf'
  if (entry.ext === 'md' || entry.ext === 'markdown') return 'markdown'
  return 'html'
}

function fileSummary(entry: RecentEntry): FileSummary {
  return {
    fileId: entry.path,
    name: entry.name,
    editorType: editorKind(entry),
    modifiedAt: entry.mtimeMs,
    sizeBytes: entry.sizeBytes,
    starred: entry.starred,
    ...(entry.missing === undefined ? {} : { missing: entry.missing }),
  }
}

function documentSummary(tab: TabSummary): ShellDocumentSummary | undefined {
  if (tab.kind === 'home') return undefined
  return {
    documentId: tab.id as DocumentId,
    title: tab.title,
    editorType: tab.kind,
    revision: 0 as Revision,
  }
}

function shellTab(tab: TabSummary): ShellTabSummary {
  if (tab.kind === 'home') {
    return { id: 'home', kind: 'home', title: tab.title, closable: false, active: tab.active }
  }
  return {
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    closable: true,
    active: tab.active,
    documentId: tab.id as DocumentId,
  }
}

export function createTemporaryElectronOfficeHost(home: HomeApi, tabs: TabsApi): OfficeHost {
  const tabListeners = new Set<(value: readonly ShellTabSummary[]) => void>()
  const settingsListeners = new Set<(value: ShellSettings) => void>()

  async function settings(): Promise<ShellSettings> {
    const [language, theme, onboardingSeen] = await Promise.all([
      home.getLanguage(),
      home.getTheme(),
      home.onboardingSeen(),
    ])
    return { language, theme, onboardingSeen }
  }

  async function bootstrap(): Promise<ShellBootstrap> {
    const [nativeTabs, currentSettings] = await Promise.all([tabs.list(), settings()])
    return {
      capabilities: host.capabilities,
      documents: nativeTabs.flatMap((tab) => {
        const document = documentSummary(tab)
        return document === undefined ? [] : [document]
      }),
      tabs: nativeTabs.map(shellTab),
      settings: currentSettings,
    }
  }

  async function afterTabMutation(action: () => Promise<void>): Promise<ShellBootstrap> {
    await action()
    return bootstrap()
  }

  const host: OfficeHost = {
    capabilities: {
      mode: 'electron',
      editors: ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'],
      nativeFilePicker: true,
      browserImport: false,
      revealInFileManager: true,
      trash: true,
      updater: true,
      credentialStore: true,
    },
    bootstrap,
    files: {
      async list() {
        return (await home.recents()).entries.map(fileSummary)
      },
      async open(fileId) {
        await home.openPath(fileId)
        return bootstrap()
      },
      async toggleStar(fileId) {
        await home.toggleStar(fileId)
        return (await home.recents()).entries.map(fileSummary)
      },
      async importFile() {
        await home.browse()
        return bootstrap()
      },
    },
    documents: {
      async list() {
        return (await bootstrap()).documents
      },
      async save(documentId) {
        throw new HostError(
          'UNSUPPORTED_CAPABILITY',
          `Saving document ${documentId} remains owned by its Electron editor.`,
          false,
          documentId,
        )
      },
      close(documentId) {
        return afterTabMutation(() => tabs.close(documentId))
      },
    },
    tabs: {
      async list() {
        return (await tabs.list()).map(shellTab)
      },
      activate(tabId) {
        return afterTabMutation(() => tabs.activate(tabId))
      },
      close(tabId) {
        return afterTabMutation(() => tabs.close(tabId))
      },
      reorder(tabId, toIndex) {
        return afterTabMutation(() => tabs.reorder(tabId, toIndex))
      },
      onChanged(listener) {
        tabListeners.add(listener)
        const unsubscribe = tabs.onChanged((value) => {
          const next = value.map(shellTab)
          for (const subscriber of tabListeners) subscriber(next)
        })
        return () => {
          tabListeners.delete(listener)
          unsubscribe()
        }
      },
    },
    settings: {
      get: settings,
      async update(patch) {
        if (patch.language !== undefined) await home.setLanguage(patch.language)
        if (patch.theme !== undefined) await home.setTheme(patch.theme)
        if (patch.onboardingSeen === true) await home.setOnboardingSeen()
        const next = await settings()
        for (const listener of settingsListeners) listener(next)
        return next
      },
      onChanged(listener) {
        settingsListeners.add(listener)
        const offTheme = home.onThemeChanged((theme) => {
          void settings().then((next) => {
            const themed = { ...next, theme }
            for (const subscriber of settingsListeners) subscriber(themed)
          })
        })
        return () => {
          settingsListeners.delete(listener)
          offTheme()
        }
      },
    },
    agent: {
      start(documentId) {
        return Promise.reject(
          new HostError(
            'UNSUPPORTED_CAPABILITY',
            'Agent sessions remain owned by the active Electron editor.',
            false,
            documentId,
          ),
        )
      },
      cancel(documentId) {
        return Promise.reject(
          new HostError(
            'UNSUPPORTED_CAPABILITY',
            'Agent sessions remain owned by the active Electron editor.',
            false,
            documentId,
          ),
        )
      },
    },
    platform: {
      async browse() {
        await home.browse()
        return bootstrap()
      },
      revealFile(fileId) {
        return home.revealPath(fileId)
      },
      async trashFiles(fileIds) {
        await home.deleteFiles([...fileIds])
        return (await home.recents()).entries.map(fileSummary)
      },
    },
  }

  return host
}
