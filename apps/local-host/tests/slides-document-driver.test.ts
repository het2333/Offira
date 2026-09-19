import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'

import { createSlidesDocumentDriver } from '../src/slides-document-driver'

let directory: string | undefined

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function fixture(): Promise<{ path: string; bytes: Uint8Array }> {
  directory = await mkdtemp(join(tmpdir(), 'nexusdesk-slides-driver-'))
  const path = join(directory, 'Deck.pptx')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="urn:test"/>')
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  await writeFile(path, bytes)
  return { path, bytes }
}

describe('Slides Local Host driver', () => {
  it('exposes authorized PPTX bytes separately from its browser bootstrap metadata', async () => {
    const { path, bytes } = await fixture()
    const driver = await createSlidesDocumentDriver(path)

    expect(await driver.bootstrap('http://127.0.0.1:43123')).toEqual({
      documentId: driver.document.documentId,
      title: basename(path),
      revision: 1,
      websocketUrl: 'ws://127.0.0.1:43123/ws',
      language: 'en',
      theme: 'system',
      contentUrl: `/api/documents/${driver.document.documentId}/content`,
    })
    expect((await driver.readContent!()).bytes).toEqual(bytes)
  })

  it('rejects an invalid candidate without replacing the authorized presentation', async () => {
    const { path } = await fixture()
    const driver = await createSlidesDocumentDriver(path)
    const before = await readFile(path)

    await expect(driver.writeContent!(new TextEncoder().encode('not a presentation'), 1)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_CONTENT',
    })

    expect(await readFile(path)).toEqual(before)
    expect(driver.document.revision).toBe(1)
    expect((await readdir(directory!)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
