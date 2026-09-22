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

it('reads and saves model credentials through the Local Host without exposing saved values', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    return new Response(JSON.stringify({ ref: 'DEEPSEEK_API_KEY', configured: true, source: 'stored', writable: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  const platform = createWebShellPlatform({} as OfficeHost, fetcher)
  await expect(platform.home.getModelCredential!('DEEPSEEK_API_KEY')).resolves.toMatchObject({ configured: true })
  await expect(platform.home.setModelCredential!('DEEPSEEK_API_KEY', 'sk-secret')).resolves.toMatchObject({ configured: true })
  expect(requests[0]).toMatchObject({ url: '/api/shell/model-credentials?ref=DEEPSEEK_API_KEY', init: { credentials: 'same-origin' } })
  expect(requests[1]).toMatchObject({ url: '/api/shell/model-credentials', init: { method: 'POST', credentials: 'same-origin' } })
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ ref: 'DEEPSEEK_API_KEY', value: 'sk-secret' })
})
