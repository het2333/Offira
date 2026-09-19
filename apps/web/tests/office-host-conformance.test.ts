import { expect, it } from 'vitest'

import { officeHostConformance } from '@nexusdesk/office-host/conformance'
import { createWebOfficeHost } from '../src/web-office-host'

it('passes the shared Office Host conformance probe', async () => {
  const bootstrap = {
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
    documents: [],
    tabs: [{ id: 'home', kind: 'home', title: 'Home', closable: false, active: true }],
    settings: { language: 'zh', theme: 'system', onboardingSeen: true },
  }
  const host = createWebOfficeHost((input) =>
    Promise.resolve(
      new Response(
        JSON.stringify(input === '/api/shell/settings' ? bootstrap.settings : bootstrap),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    ),
  )

  await expect(officeHostConformance(() => host)).resolves.toEqual({
    mode: 'browser',
    activeTabId: 'home',
    language: 'zh',
  })
})
