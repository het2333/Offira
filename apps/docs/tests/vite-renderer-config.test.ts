/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { createRendererServerOptions } from '../vite.renderer.config'

describe('Docs Web renderer configuration', () => {
  it('proxies Local Host APIs only in explicit local Web development mode', () => {
    const origin = 'http://127.0.0.1:43123'

    expect(
      createRendererServerOptions({
        NEXUSDESK_LOCAL_WEB: '1',
        NEXUSDESK_LOCAL_ORIGIN: origin,
      }),
    ).toMatchObject({
      proxy: {
        '/api': { target: origin },
        '/ws': { target: 'ws://127.0.0.1:43123', ws: true },
      },
    })
  })

  it('requires an explicit Local Host origin in local Web mode', () => {
    expect(() => createRendererServerOptions({ NEXUSDESK_LOCAL_WEB: '1' })).toThrow(
      /NEXUSDESK_LOCAL_ORIGIN/,
    )
  })
})
