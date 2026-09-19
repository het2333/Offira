import { request as httpRequest } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { HostError, type ShellDocumentSummary } from '@nexusdesk/office-host'
import { DocumentDriverRegistry, type LocalDocumentDriver } from '../src/document-driver'
import { startLocalHost, type RunningLocalHost } from '../src/server'

const contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const originalBytes = new Uint8Array([80, 75, 3, 4, 1])
const nextBytes = new Uint8Array([80, 75, 3, 4, 2])

let running: RunningLocalHost | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

async function authenticate(): Promise<string> {
  const response = await fetch(running!.bootstrapUrl, { redirect: 'manual' })
  return response.headers.get('set-cookie')!.split(';')[0]!
}

function createDriver(): LocalDocumentDriver & {
  writes: Array<{ bytes: Uint8Array; expectedRevision: number }>
} {
  const writes: Array<{ bytes: Uint8Array; expectedRevision: number }> = []
  const driver: LocalDocumentDriver & { writes: typeof writes } = {
    document: {
      documentId: 'doc-1',
      title: 'Report.docx',
      editorType: 'docs',
      revision: 1,
    },
    writes,
    async bootstrap() {
      return {}
    },
    async execute() {
      return {}
    },
    async readContent() {
      return { bytes: originalBytes, contentType }
    },
    async writeContent(bytes, expectedRevision) {
      if (expectedRevision !== driver.document.revision) {
        throw new HostError(
          'REVISION_CONFLICT' as never,
          'The document changed after this editor loaded it.',
          false,
        )
      }
      writes.push({ bytes, expectedRevision })
      driver.document.revision += 1
      return { ...driver.document } as ShellDocumentSummary
    },
    async close() {},
  }
  return driver
}

async function startWith(driver: LocalDocumentDriver): Promise<string> {
  running = await startLocalHost({
    documentDrivers: new DocumentDriverRegistry([driver]),
  })
  return authenticate()
}

async function oversizedWrite(cookie: string): Promise<{ status: number; body: unknown }> {
  const url = new URL('/api/documents/doc-1/content', running!.origin)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          Origin: running!.origin,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(134_217_729),
          'If-Match': '1',
          Connection: 'close',
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          })
        })
      },
    )
    request.once('error', reject)
    request.end()
  })
}

describe('Local Host document content routes', () => {
  it('streams authorized bytes and advances the expected revision', async () => {
    const driver = createDriver()
    const cookie = await startWith(driver)

    const loaded = await fetch(`${running!.origin}/api/documents/doc-1/content`, {
      headers: { Cookie: cookie },
    })
    const saved = await fetch(`${running!.origin}/api/documents/doc-1/content`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/octet-stream',
        'If-Match': '1',
      },
      body: nextBytes,
    })

    expect(loaded.status).toBe(200)
    expect(loaded.headers.get('content-type')).toBe(contentType)
    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(originalBytes)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ documentId: 'doc-1', revision: 2 })
    expect(driver.writes).toEqual([{ bytes: nextBytes, expectedRevision: 1 }])
  })

  it('rejects stale and oversized writes before committing bytes', async () => {
    const driver = createDriver()
    const cookie = await startWith(driver)

    const stale = await fetch(`${running!.origin}/api/documents/doc-1/content`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/octet-stream',
        'If-Match': '0',
      },
      body: nextBytes,
    })
    const oversized = await oversizedWrite(cookie)

    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      code: 'REVISION_CONFLICT',
      retryable: false,
    })
    expect(oversized).toMatchObject({
      status: 413,
      body: { code: 'CONTENT_TOO_LARGE', retryable: false },
    })
    expect(driver.writes).toHaveLength(0)
    expect(driver.document.revision).toBe(1)
  })

  it('requires binary content, a decimal revision, and driver content support', async () => {
    const driver = createDriver()
    const cookie = await startWith(driver)
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'If-Match': 'current' }

    const invalid = await fetch(`${running!.origin}/api/documents/doc-1/content`, {
      method: 'PUT',
      headers,
      body: '{}',
    })

    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' })

    await running!.close()
    running = undefined
    const unsupported = createDriver()
    delete unsupported.readContent
    delete unsupported.writeContent
    const unsupportedCookie = await startWith(unsupported)
    const response = await fetch(`${running!.origin}/api/documents/doc-1/content`, {
      headers: { Cookie: unsupportedCookie },
    })
    expect(response.status).toBe(405)
    expect(await response.json()).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })
})
