import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang } from '@genoffice/i18n'
import {
  LocaleProvider,
  GENOFFICE_PRODUCT_CONFIG,
  OfficeHostProvider,
  SharedShell,
  type ShellPlatformServices,
} from '@nexusdesk/shell-ui'
import type { HomeApi } from '../../shared/home-api'
import type { IntegrationsApi } from '../../shared/integrations-api'
import type { TabsApi } from '../../shared/tabs-api'
import { createElectronOfficeHost } from './electron-office-host'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/dropdown.css'
import '@nexusdesk/shell-ui/styles.css'
import { installScreenTips } from '@genoffice/ui'

installScreenTips()

declare global {
  interface Window {
    aiOffice: HomeApi
    aiOfficeTabs: TabsApi
    aiOfficeIntegrations?: IntegrationsApi
  }
}

// macOS shell window is created with vibrancy; a transparent body lets the
// editor views' translucent regions (e.g. slides thumbnail pane) show it
const IS_MAC = navigator.platform.toLowerCase().includes('mac')
if (IS_MAC) document.body.classList.add('vib')
// non-mac: the tab strip doubles as the title bar (caption buttons overlay it)
document.body.classList.add(IS_MAC ? 'mac' : 'overlay-title-bar')

// resolve the persisted language, first-run flag, and theme before first paint
// so the UI never flashes (home showing briefly before the onboarding overlay)
const host = createElectronOfficeHost(window)
const platform: ShellPlatformServices = {
  home: window.aiOffice,
  tabs: window.aiOfficeTabs,
  ...(window.aiOfficeIntegrations === undefined
    ? {}
    : { integrations: window.aiOfficeIntegrations }),
}

void host.settings.get().then(({ language: lang, onboardingSeen, theme }) => {
  document.documentElement.lang = htmlLang(lang)
  // apply theme attribute before first paint to avoid flash
  if (theme !== 'system') {
    document.documentElement.setAttribute('data-theme', theme)
  }
  host.settings.onChanged(({ theme: next }) => {
    if (next === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  })
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <OfficeHostProvider host={host} platform={platform}>
        <LocaleProvider initial={lang}>
          <SharedShell product={GENOFFICE_PRODUCT_CONFIG} initialOnboardingSeen={onboardingSeen} />
        </LocaleProvider>
      </OfficeHostProvider>
    </React.StrictMode>,
  )
})
