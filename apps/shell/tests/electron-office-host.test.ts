import { expect, it } from 'vitest'

import { officeHostConformance } from '@nexusdesk/office-host/conformance'
import type { HomeApi } from '../src/shared/home-api'
import type { TabsApi } from '../src/shared/tabs-api'
import {
  createElectronOfficeHost,
  type ElectronPreloadWindow,
} from '../src/renderer/src/electron-office-host'

function fakePreloadWindow(): ElectronPreloadWindow {
  const aiOffice = {
    getLanguage: () => Promise.resolve('zh' as const),
    getTheme: () => Promise.resolve('system' as const),
    onboardingSeen: () => Promise.resolve(true),
    recents: () => Promise.resolve({ entries: [], total: 0, totalAll: 0 }),
    onThemeChanged: () => () => {},
    browse: () => Promise.resolve(),
    revealPath: () => Promise.resolve(),
    deleteFiles: () => Promise.resolve(),
  } as HomeApi
  const aiOfficeTabs = {
    list: () =>
      Promise.resolve([
        { id: 'home', kind: 'home' as const, title: 'Home', closable: false, active: true },
      ]),
    onChanged: () => () => {},
  } as TabsApi
  return { aiOffice, aiOfficeTabs }
}

it('passes the shared Office Host conformance probe', async () => {
  await expect(
    officeHostConformance(() => createElectronOfficeHost(fakePreloadWindow())),
  ).resolves.toEqual({
    mode: 'electron',
    activeTabId: 'home',
    language: 'zh',
  })
})

it('advertises only preload-backed native platform capabilities', async () => {
  const host = createElectronOfficeHost(fakePreloadWindow())
  await expect(host.bootstrap()).resolves.toMatchObject({
    capabilities: {
      mode: 'electron',
      nativeFilePicker: true,
      revealInFileManager: true,
      trash: true,
    },
  })
})
