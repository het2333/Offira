import ReactDOM from 'react-dom/client'
import { htmlLang, type Lang } from '@genoffice/i18n'
import { applyAiPanelPrefs, installScreenTips } from '@genoffice/ui'

import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ribbon-collapse.css'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/ai-panel-prefs.css'
import '@genoffice/ui/ai-scope-quote.css'
import '@univerjs/preset-sheets-core/lib/index.css'

import { App } from './App'
import { installCanvasFontFallback, registerCellFontAliases } from './cell-font-fallback'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import type { UiTheme } from '../shared/desktop-api'
import {
  installBrowserHostApi,
  loadBrowserHostBootstrap,
  selectSheetsHost,
} from './browser-host-api'
import './styles.css'

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', ({ updates }) => {
    const replacesUniverRuntime = updates.some(
      ({ path }) => path.endsWith('/App.tsx') || path.endsWith('/univer-sync.ts'),
    )
    if (replacesUniverRuntime) window.location.reload()
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing application root.')

installScreenTips()
installCanvasFontFallback()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

// Canvas fillText never triggers @font-face downloads, so the bundled Carlito
// faces (Calibri/Aptos aliases in styles.css) must be loaded before Univer's
// first skeleton — MDW, wrap points, and #### overflow all measure with them.
async function loadCellFonts(): Promise<void> {
  const loads: Promise<unknown>[] = [registerCellFontAliases()]
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) {
    for (const family of ['Calibri', 'Aptos', "'Aptos Narrow'", 'Carlito']) {
      loads.push(document.fonts?.load?.(`${variant}16px ${family}`)?.catch(() => {}) ?? [])
    }
  }
  // Local assets resolve in milliseconds; the timeout only guards a broken
  // bundle from blanking the app.
  await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, 3000))])
}

async function bootstrap(): Promise<void> {
  let selection
  try {
    selection = await selectSheetsHost({
      search: window.location.search,
      electronApi: window.desktopApi,
      installBrowser: async () => {
        const documentId = new URLSearchParams(window.location.search).get('documentId')
        const browserBootstrap = window.nexusdeskBootstrap ?? (
          documentId === null
            ? undefined
            : await loadBrowserHostBootstrap(documentId)
        )
        if (browserBootstrap === undefined) throw new Error('The document id is missing.')
        return installBrowserHostApi(browserBootstrap)
      },
    })
  } catch (error: unknown) {
    renderStartupError(error instanceof Error ? error.message : 'NexusDesk Sheets could not start.')
    return
  }
  if (selection.kind === 'error') {
    renderStartupError(selection.message)
    return
  }
  const desktopApi = window.desktopApi
  if (desktopApi === undefined) {
    renderStartupError('NexusDesk Sheets could not start because its host API is unavailable.')
    return
  }
  let lang: Lang = 'zh'
  let theme: UiTheme = 'system'
  try {
    // per-promise catch: standalone runs have no app:get-theme handler, and
    // that rejection must not drop a resolved language
    ;[lang, theme] = await Promise.all([
      desktopApi.getLanguage().catch(() => 'zh' as const),
      desktopApi.getTheme().catch(() => 'system' as const),
    ])
  } catch {
    /* dev renderer without the preload bridge */
  }
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  applyTheme(theme)
  await loadCellFonts()
  desktopApi.onThemeChanged(applyTheme)
  void desktopApi
    .getAiPanelPrefs()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  desktopApi.onAiPanelPrefsChanged(applyAiPanelPrefs)
  ReactDOM.createRoot(root!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
}

function renderStartupError(message: string): void {
  const view = document.createElement('main')
  view.setAttribute('role', 'alert')
  view.className = 'startup-error'
  const heading = document.createElement('h1')
  heading.textContent = 'NexusDesk Sheets could not start'
  const detail = document.createElement('p')
  detail.textContent = message
  view.append(heading, detail)
  root!.replaceChildren(view)
}

void bootstrap()
