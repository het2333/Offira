import { HostError, type EditorKind, type OfficeHost } from '@nexusdesk/office-host'
import type {
  HomeApi,
  ModelCredentialStatus,
  RecentEntry,
  RecentPage,
  RecentQuery,
  ShellPlatformServices,
} from '@nexusdesk/shell-ui'

const EXTENSION_BY_EDITOR: Record<EditorKind, string> = {
  docs: 'docx',
  sheets: 'xlsx',
  slides: 'pptx',
  pdf: 'pdf',
  markdown: 'md',
  html: 'html',
}

function unsupported(name: string): never {
  throw new HostError(
    'UNSUPPORTED_CAPABILITY',
    `${name} is unavailable in the Offira browser shell.`,
    false,
  )
}

function page(entries: RecentEntry[], query: RecentQuery = {}): RecentPage {
  const totalAll = entries.length
  const matching =
    query.ext === undefined ? entries : entries.filter((entry) => entry.ext === query.ext)
  const offset = Math.max(0, query.offset ?? 0)
  const limit = Math.max(0, query.limit ?? 50)
  return {
    entries: matching.slice(offset, offset + limit),
    total: matching.length,
    totalAll,
  }
}

export function createWebShellPlatform(
  host: OfficeHost,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): ShellPlatformServices {
  async function credentialRequest(url: string, init: RequestInit): Promise<ModelCredentialStatus> {
    const response = await fetcher(url, { ...init, credentials: 'same-origin' })
    if (!response.ok) {
      throw new Error(response.status === 409
        ? '此 API Key 由启动环境提供，请在启动配置中修改。'
        : '无法保存 API Key，请检查本地服务连接后重试。')
    }
    return await response.json() as ModelCredentialStatus
  }
  async function entries(): Promise<RecentEntry[]> {
    return (await host.files.list()).map((file) => ({
      path: file.fileId,
      name: file.name,
      ext: EXTENSION_BY_EDITOR[file.editorType],
      mtimeMs: file.modifiedAt,
      sizeBytes: file.sizeBytes,
      starred: file.starred,
      ...(file.missing === undefined ? {} : { missing: file.missing }),
    }))
  }

  const realHome = {
    getModelCredential(ref: string) {
      return credentialRequest(`/api/shell/model-credentials?ref=${encodeURIComponent(ref)}`, {})
    },
    setModelCredential(ref: string, value: string | null) {
      return credentialRequest('/api/shell/model-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, value }),
      })
    },
    async recents(query?: RecentQuery) {
      return page(await entries(), query)
    },
    async starred(query?: RecentQuery) {
      return page(
        (await entries()).filter((entry) => entry.starred),
        query,
      )
    },
    async toggleStar(fileId: string) {
      await host.files.toggleStar(fileId)
    },
    async openPath(fileId: string) {
      await host.files.open(fileId)
    },
    async getLanguage() {
      return (await host.settings.get()).language
    },
    async setLanguage(language: Parameters<HomeApi['setLanguage']>[0]) {
      await host.settings.update({ language })
    },
    async onboardingSeen() {
      return (await host.settings.get()).onboardingSeen
    },
    async setOnboardingSeen() {
      return (await host.settings.update({ onboardingSeen: true })).onboardingSeen
    },
    async getTheme() {
      return (await host.settings.get()).theme
    },
    async setTheme(theme: Parameters<HomeApi['setTheme']>[0]) {
      await host.settings.update({ theme })
    },
    onThemeChanged(handler: Parameters<HomeApi['onThemeChanged']>[0]) {
      return host.settings.onChanged(({ theme }) => handler(theme))
    },
    async folderRoot() {
      return { path: '', name: '', usable: false }
    },
    onFolderChanged() {
      return () => {}
    },
    async starPromptShouldShow() {
      return { show: false, docOpens: 0 }
    },
  }

  const home = new Proxy(realHome as unknown as HomeApi, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      return () => unsupported(String(property))
    },
  })

  return {
    home,
    tabs: {
      showMenu: async () => {},
      showNewMenu: async () => {},
      showAppMenu: async () => {},
      notifyChromePressed: () => {},
      onChromePressed: () => () => {},
    },
  }
}
