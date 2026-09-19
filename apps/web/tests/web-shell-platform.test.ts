import { expect, it, vi } from 'vitest'

import type { OfficeHost } from '@nexusdesk/office-host'
import { createWebShellPlatform } from '../src/web-shell-platform'

it('maps authorized Host files and settings into the shared Shell compatibility surface', async () => {
  const open = vi.fn().mockResolvedValue({})
  const update = vi.fn().mockResolvedValue({ language: 'en', theme: 'dark', onboardingSeen: true })
  const host = {
    files: {
      list: () =>
        Promise.resolve([
          {
            fileId: 'f1',
            name: 'Forecast.xlsx',
            editorType: 'sheets',
            modifiedAt: 123,
            sizeBytes: 456,
            starred: true,
          },
        ]),
      open,
    },
    settings: {
      get: () => Promise.resolve({ language: 'en', theme: 'dark', onboardingSeen: true }),
      update,
    },
  } as unknown as OfficeHost
  const platform = createWebShellPlatform(host)

  await expect(platform.home.recents()).resolves.toMatchObject({
    entries: [{ path: 'f1', name: 'Forecast.xlsx', ext: 'xlsx', starred: true }],
    total: 1,
  })
  await platform.home.openPath('f1')
  await platform.home.setTheme('dark')

  expect(open).toHaveBeenCalledWith('f1')
  expect(update).toHaveBeenCalledWith({ theme: 'dark' })
})
