/**
 * @vitest-environment jsdom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { OfficeHost } from '@nexusdesk/office-host'
import {
  NEXUSDESK_PRODUCT_CONFIG,
  OfficeHostProvider,
  SharedShell,
  type ShellPlatformServices,
} from '../src/index'

it('advertises Docs and Sheets in the NexusDesk product configuration', () => {
  expect(NEXUSDESK_PRODUCT_CONFIG.editors).toEqual(['docs', 'sheets'])
})

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('hides unsupported browser and GenOffice-only actions in NexusDesk', async () => {
  const unsupportedCalls: string[] = []
  const unsupported = (name: string) => () => {
    unsupportedCalls.push(name)
    throw new Error(`${name} is unsupported`)
  }
  const tabs = [
    { id: 'home', kind: 'home' as const, title: 'Home', closable: false as const, active: true },
  ]
  const host = {
    capabilities: {
      mode: 'browser',
      editors: ['sheets'],
      nativeFilePicker: false,
      browserImport: false,
      revealInFileManager: false,
      trash: false,
      updater: false,
      credentialStore: false,
    },
    bootstrap: async () => ({
      capabilities: host.capabilities,
      documents: [],
      tabs,
      settings: { language: 'zh', theme: 'system', onboardingSeen: true },
    }),
    tabs: { list: async () => tabs, onChanged: () => () => {} },
  } as unknown as OfficeHost
  const platform = {
    home: {
      recents: async () => ({
        entries: [
          {
            path: 'f1',
            name: 'Forecast.xlsx',
            ext: 'xlsx',
            mtimeMs: 1,
            sizeBytes: 16,
            starred: false,
          },
        ],
        total: 1,
        totalAll: 1,
      }),
      starred: async () => ({ entries: [], total: 0, totalAll: 1 }),
      folderRoot: async () => ({ path: '', name: '', usable: false }),
      onFolderChanged: () => () => {},
      starPromptShouldShow: async () => ({ show: false, docOpens: 0 }),
      getTheme: async () => 'system',
      getAiProviders: unsupported('getAiProviders'),
      getAiSettings: unsupported('getAiSettings'),
      getDefaultSaveDir: unsupported('getDefaultSaveDir'),
      getAnalyticsEnabled: unsupported('getAnalyticsEnabled'),
      getAutoSaveDefault: unsupported('getAutoSaveDefault'),
      getAiPanelPrefs: unsupported('getAiPanelPrefs'),
      getUpdateChannel: unsupported('getUpdateChannel'),
      getAppVersion: unsupported('getAppVersion'),
      githubStars: unsupported('githubStars'),
    },
    tabs: {
      showMenu: async () => {},
      showNewMenu: async () => {},
      showAppMenu: async () => {},
      notifyChromePressed: () => {},
      onChromePressed: () => () => {},
    },
  } as unknown as ShellPlatformServices

  await act(async () => {
    root.render(
      <OfficeHostProvider host={host} platform={platform}>
        <SharedShell product={NEXUSDESK_PRODUCT_CONFIG} initialOnboardingSeen />
      </OfficeHostProvider>,
    )
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(container.textContent).toContain('NexusDesk')
  expect(container.textContent).not.toContain('Genspark Projects')
  expect(container.querySelector('.account-entry')).toBeNull()
  expect(container.querySelector('.tab-app-menu-btn')).toBeNull()
  expect(container.querySelector('.tab-new-btn')).toBeNull()
  expect(container.querySelector('.tab-overflow-btn')).toBeNull()
  expect(container.querySelector('.row-check')).toBeNull()

  const more = container.querySelector<HTMLButtonElement>('.more-btn')
  expect(more).not.toBeNull()
  await act(async () => more!.click())
  const menu = container.querySelector('[role="menu"]')
  expect(menu?.textContent).not.toMatch(/Reveal|Delete/)
  expect(menu?.textContent).not.toMatch(
    /Copy path|Move to folder|Rename|Duplicate|复制路径|移动到文件夹|重命名|创建副本/,
  )

  await act(async () => container.querySelector<HTMLButtonElement>('.account-button')!.click())
  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  expect(container.textContent).toContain('通用')
  expect(container.textContent).not.toContain('AI 模型')
  expect(unsupportedCalls).toEqual([])
})
