import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROTOCOL_VERSION } from '@nexusdesk/protocol'
import { startLocalHost, type RunningLocalHost } from '../src/server'

let running: RunningLocalHost | undefined
let temporaryDirectory: string | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
  if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

async function authenticatedHeaders(): Promise<{ cookie: string }> {
  const response = await fetch(running!.bootstrapUrl, { redirect: 'manual' })
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]! }
}

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

  it('returns authenticated document summaries without filesystem paths', async () => {
    running = await startLocalHost({
      documents: [{
        documentId: 'document-1',
        title: 'Forecast.xlsx',
        editorType: 'sheets',
        revision: 3,
        path: '/Users/example/secret/Forecast.xlsx',
      }],
    })
    const headers = await authenticatedHeaders()

    const response = await fetch(`${running.origin}/api/bootstrap`, { headers })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      documents: [{ documentId: 'document-1', title: 'Forecast.xlsx', editorType: 'sheets', revision: 3 }],
    })
  })

  it('serves hashed assets immutably and falls client routes back to no-store shell HTML', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'nexusdesk-web-'))
    const webRoot = join(temporaryDirectory, 'web')
    const sheetsRoot = join(temporaryDirectory, 'sheets')
    await mkdir(join(webRoot, 'assets'), { recursive: true })
    await mkdir(sheetsRoot, { recursive: true })
    await writeFile(join(webRoot, 'index.html'), '<div id="root">shell</div>')
    await writeFile(join(webRoot, 'assets', 'index-a1b2c3.js'), 'globalThis.shellLoaded=true')
    await writeFile(join(sheetsRoot, 'index.html'), '<div id="root">sheets</div>')
    running = await startLocalHost({ staticAssets: { webRoot, sheetsRoot } })
    const headers = await authenticatedHeaders()

    const asset = await fetch(`${running.origin}/assets/index-a1b2c3.js`, { headers })
    const route = await fetch(`${running.origin}/edit/sheets/document-1`, { headers })
    const unknownApi = await fetch(`${running.origin}/api/unknown`, { headers })

    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(route.headers.get('cache-control')).toBe('no-store')
    expect(await route.text()).toContain('shell')
    expect(unknownApi.status).toBe(404)
    expect(unknownApi.headers.get('content-type')).toContain('application/json')
  })
})
