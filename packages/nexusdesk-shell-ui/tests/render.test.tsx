/**
 * @vitest-environment jsdom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { OfficeHost } from '@nexusdesk/office-host'
import { OfficeHostProvider, SharedShell, type ShellPlatformServices } from '../src/index'

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

it('renders the original home and tab chrome through an injected host', async () => {
  const tabs = [
    { id: 'home', kind: 'home' as const, title: 'Home', closable: false as const, active: false },
    {
      id: 'document:d1',
      kind: 'sheets' as const,
      title: 'Forecast.xlsx',
      closable: true as const,
      active: true,
      documentId: 'd1',
    },
  ]
  const host = {
    capabilities: {
      mode: 'browser',
      editors: ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'],
      nativeFilePicker: false,
      browserImport: false,
      revealInFileManager: false,
      trash: false,
      updater: false,
      credentialStore: false,
    },
    bootstrap: async () => ({
      capabilities: host.capabilities,
      documents: [{ documentId: 'd1', title: 'Forecast.xlsx', editorType: 'sheets', revision: 0 }],
      tabs,
      settings: { language: 'zh', theme: 'system', onboardingSeen: true },
    }),
    tabs: { list: async () => tabs, onChanged: () => () => {} },
  } as unknown as OfficeHost
  const platform = {
    home: {
      recents: async () => ({ entries: [], total: 0, totalAll: 0 }),
      starred: async () => ({ entries: [], total: 0, totalAll: 0 }),
      folderRoot: async () => ({ path: '/tmp', name: 'tmp', usable: true }),
      listFolder: async () => ({ path: '/tmp', folders: [], files: [] }),
      onFolderChanged: () => () => {},
      accountStatus: async () => ({ loggedIn: false }),
      starPromptShouldShow: async () => ({ show: false, docOpens: 0 }),
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
        <SharedShell initialOnboardingSeen />
      </OfficeHostProvider>,
    )
    await Promise.resolve()
  })

  expect(container.querySelector('img[alt="GenOffice"]')).not.toBeNull()
  expect([...container.querySelectorAll('.tab-title')].map((node) => node.textContent)).toEqual([
    '首页',
    'Forecast.xlsx',
  ])
})
