import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'

import { createDocsDocumentDriver } from '../src/docs-document-driver'

let directory: string | undefined

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function fixture(name = 'Report.docx'): Promise<{ path: string; bytes: Uint8Array }> {
  directory = await mkdtemp(join(tmpdir(), 'nexusdesk-docs-driver-'))
  const path = join(directory, name)
  const bytes = await buildTestDocx('Initial')
  await writeFile(path, bytes)
  return { path, bytes }
}

async function buildTestDocx(text: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe('Docs Local Host driver', () => {
  it('loads a real docx and exposes metadata without embedding bytes in bootstrap', async () => {
    const { path, bytes } = await fixture()
    const driver = await createDocsDocumentDriver(path)

    const bootstrap = await driver.bootstrap('http://127.0.0.1:43123')
    const content = await driver.readContent!()

    expect(bootstrap).toEqual({
      documentId: driver.document.documentId,
      title: basename(path),
      revision: 1,
      websocketUrl: 'ws://127.0.0.1:43123/ws',
      language: 'en',
      theme: 'system',
      contentUrl: `/api/documents/${driver.document.documentId}/content`,
    })
    expect(bootstrap).not.toHaveProperty('bytes')
    expect(content.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(content.bytes).toEqual(bytes)
  })

  it('does not replace the docx or advance revision when candidate parsing fails', async () => {
    const { path } = await fixture()
    const driver = await createDocsDocumentDriver(path)
    const before = await readFile(path)

    await expect(
      driver.writeContent!(new TextEncoder().encode('not a zip'), 1),
    ).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_CONTENT' })

    expect(await readFile(path)).toEqual(before)
    expect(driver.document.revision).toBe(1)
    expect((await readdir(directory!)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('serializes concurrent writes so only one matching revision can commit', async () => {
    const { path } = await fixture()
    const driver = await createDocsDocumentDriver(path)
    const first = await buildTestDocx('First')
    const second = await buildTestDocx('Second')

    const results = await Promise.allSettled([
      driver.writeContent!(first, 1),
      driver.writeContent!(second, 1),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CONFLICT' },
    })
    expect(driver.document.revision).toBe(2)
    expect(await readFile(path)).toEqual(Buffer.from(first))
    expect((await readdir(directory!)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects an invalid startup docx before authorizing it', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexusdesk-docs-driver-'))
    const path = join(directory, 'Broken.docx')
    await writeFile(path, 'not a docx')

    await expect(createDocsDocumentDriver(path)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_CONTENT',
    })
  })
})
