import { afterEach, describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION } from '@nexusdesk/protocol'
import { startLocalHost, type RunningLocalHost } from '../src/server'

let running: RunningLocalHost | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

describe('startLocalHost HTTP bootstrap', () => {
  it('exchanges the launch token once and redirects without it', async () => {
    running = await startLocalHost()

    const first = await fetch(running.bootstrapUrl, { redirect: 'manual' })
    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toBe('/')
    expect(first.headers.get('set-cookie')).toMatch(
      /^nexusdesk_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/,
    )

    const replay = await fetch(running.bootstrapUrl, { redirect: 'manual' })
    expect(replay.status).toBe(401)
  })

  it('keeps the health response free of document and session data', async () => {
    running = await startLocalHost()

    const response = await fetch(`${running.origin}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION })
  })
})
