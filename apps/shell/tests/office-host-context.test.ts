import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createElement, type PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { OfficeHost } from '@nexusdesk/office-host'
import type { HomeApi } from '../src/shared/home-api'
import type { TabsApi } from '../src/shared/tabs-api'
import { OfficeHostProvider, useOfficeHost } from '@nexusdesk/shell-ui'
import { createElectronOfficeHost } from '../src/renderer/src/electron-office-host'

function Consumer({ expected }: { expected?: OfficeHost }) {
  const host = useOfficeHost()
  return createElement('span', null, host === expected ? 'injected' : 'different')
}

describe('OfficeHostProvider', () => {
  it('reads the injected host and fails clearly without a provider', () => {
    expect(() => renderToStaticMarkup(createElement(Consumer))).toThrow(/OfficeHostProvider/)

    const host = {} as OfficeHost
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(OfficeHostProvider, { host }, children)
    expect(
      renderToStaticMarkup(wrapper({ children: createElement(Consumer, { expected: host }) })),
    ).toContain('injected')
  })

  it('keeps product components independent of Electron globals', async () => {
    const root = resolve(import.meta.dirname, '../../../packages/nexusdesk-shell-ui/src')
    const productSources = await Promise.all(
      [
        'AppFrame.tsx',
        'Home.tsx',
        'Onboarding.tsx',
        'SettingsModal.tsx',
        'StarPromptCard.tsx',
        'TabBar.tsx',
        'locale.tsx',
      ].map((name) => readFile(resolve(root, name), 'utf8')),
    )

    expect(productSources.join('\n')).not.toMatch(
      /window\.(?:aiOffice|aiOfficeTabs|aiOfficeIntegrations)/,
    )
  })
})

describe('Electron OfficeHost composition adapter', () => {
  it('maps preload tabs and settings into one semantic bootstrap', async () => {
    const home = {
      getLanguage: () => Promise.resolve('zh' as const),
      getTheme: () => Promise.resolve('system' as const),
      onboardingSeen: () => Promise.resolve(true),
      browse: () => Promise.resolve(),
    } as HomeApi
    const tabs = {
      list: () =>
        Promise.resolve([
          { id: 'home', kind: 'home' as const, title: 'Home', closable: false, active: false },
          {
            id: 'tab-1',
            kind: 'sheets' as const,
            title: 'Forecast.xlsx',
            closable: true,
            active: true,
            filePath: '/tmp/Forecast.xlsx',
          },
        ]),
    } as TabsApi

    const bootstrap = await createElectronOfficeHost({
      aiOffice: home,
      aiOfficeTabs: tabs,
    }).bootstrap()

    expect(bootstrap).toMatchObject({
      capabilities: { mode: 'electron', nativeFilePicker: true },
      documents: [{ documentId: 'tab-1', editorType: 'sheets', title: 'Forecast.xlsx' }],
      tabs: [
        { id: 'home', kind: 'home', active: false },
        { id: 'tab-1', kind: 'sheets', documentId: 'tab-1', active: true },
      ],
      settings: { language: 'zh', theme: 'system', onboardingSeen: true },
    })
  })
})
