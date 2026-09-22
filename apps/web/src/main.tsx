import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang } from '@genoffice/i18n'
import { installScreenTips } from '@genoffice/ui'
import {
  LocaleProvider,
  NEXUSDESK_PRODUCT_CONFIG,
  OfficeHostProvider,
  SharedShell,
} from '@nexusdesk/shell-ui'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/dropdown.css'
import '@nexusdesk/shell-ui/styles.css'

import { fileLaunchMessage } from './file-launch-guard'
import { createWebOfficeHost } from './web-office-host'
import { createWebShellPlatform } from './web-shell-platform'

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

function renderStatus(root: HTMLElement, title: string, message: string): void {
  root.replaceChildren()
  const main = document.createElement('main')
  main.className = 'nexusdesk-launch-status'
  main.setAttribute('role', 'alert')
  const heading = document.createElement('h1')
  heading.textContent = title
  const detail = document.createElement('p')
  detail.textContent = message
  main.append(heading, detail)
  root.append(main)
}

async function start(): Promise<void> {
  const root = document.getElementById('root')
  if (root === null) throw new Error('Missing Offira root element')

  const directLaunch = fileLaunchMessage(new URL(window.location.href))
  if (directLaunch !== undefined) {
    renderStatus(root, '请通过本地服务打开 Offira', directLaunch)
    return
  }

  installScreenTips()
  const host = createWebOfficeHost()
  const platform = createWebShellPlatform(host)
  try {
    const bootstrap = await host.bootstrap()
    document.documentElement.lang = htmlLang(bootstrap.settings.language)
    applyTheme(bootstrap.settings.theme)
    host.settings.onChanged(({ language, theme }) => {
      document.documentElement.lang = htmlLang(language)
      applyTheme(theme)
    })
    createRoot(root).render(
      <React.StrictMode>
        <OfficeHostProvider host={host} platform={platform}>
          <LocaleProvider initial={bootstrap.settings.language}>
            <SharedShell
              product={NEXUSDESK_PRODUCT_CONFIG}
              initialOnboardingSeen={bootstrap.settings.onboardingSeen}
            />
          </LocaleProvider>
        </OfficeHostProvider>
      </React.StrictMode>,
    )
  } catch (error: unknown) {
    renderStatus(
      root,
      'Offira 无法连接本地服务',
      error instanceof Error ? error.message : 'The Local Host connection failed.',
    )
  }
}

void start()
