import { createElement, type ReactNode } from 'react'

import type { HomeApi } from '../src/shared/home-api'
import type { IntegrationsApi } from '../src/shared/integrations-api'
import type { TabsApi } from '../src/shared/tabs-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { OfficeHostProvider } from '../src/renderer/src/office-host-context'
import { createTemporaryElectronOfficeHost } from '../src/renderer/src/temporary-electron-office-host'

const tabs: TabsApi = {
  list: () =>
    Promise.resolve([{ id: 'home', kind: 'home', title: 'Home', closable: false, active: true }]),
  activate: () => Promise.resolve(),
  close: () => Promise.resolve(),
  showMenu: () => Promise.resolve(),
  showNewMenu: () => Promise.resolve(),
  showAppMenu: () => Promise.resolve(),
  reorder: () => Promise.resolve(),
  onChanged: () => () => {},
  notifyChromePressed: () => {},
  onChromePressed: () => () => {},
}

function fallbackHome(): HomeApi {
  return {
    getLanguage: () => Promise.resolve('en'),
    setLanguage: () => Promise.resolve(),
    getTheme: () => Promise.resolve('system'),
    setTheme: () => Promise.resolve(),
    onboardingSeen: () => Promise.resolve(true),
    setOnboardingSeen: () => Promise.resolve(true),
    onThemeChanged: () => () => {},
  } as HomeApi
}

export function shellTestTree(
  children: ReactNode,
  options: {
    home?: HomeApi | undefined
    integrations?: IntegrationsApi | undefined
    language?: 'en' | 'zh' | undefined
  } = {},
): React.ReactElement {
  const home = options.home ?? window.aiOffice ?? fallbackHome()
  const integrations = options.integrations ?? window.aiOfficeIntegrations
  const host = createTemporaryElectronOfficeHost(home, tabs)
  return createElement(
    OfficeHostProvider,
    {
      host,
      platform: {
        home,
        tabs,
        ...(integrations === undefined ? {} : { integrations }),
      },
    },
    createElement(LocaleProvider, { initial: options.language ?? 'en' }, children),
  )
}
