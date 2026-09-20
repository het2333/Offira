import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'

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
  it('recovers complete checkpoint bytes with an immutable source and promotes only on Save', async () => {
    const { path, bytes: original } = await fixture()
    const options = { workingCopyRoot: join(directory!, 'recovery') }
    const driver = await createDocsDocumentDriver(path, options)
    expect(driver.workingCopy).toBeDefined()
    const port = driver.workingCopy!
    const source = await port.acquireSource()
    const status = await port.store.getStatus()
    const zip = await JSZip.loadAsync(await buildTestDocx('Manual edit. Agent edit.'))
    zip.file('word/header1.xml', '<w:hdr>Manual header</w:hdr>')
    const payload = await zip.generateAsync({ type: 'uint8array' })
    const bytes = await port.materialize({
      sourceContentId: source.sourceContentId,
      payloadKind: 'docx-bytes',
      parts: new Map([['document', payload]]),
    })
    const receipt = await port.store.commitCheckpoint({
      documentEpoch: status.documentEpoch,
      expectedSavedRevision: 1,
      expectedWorkingRevision: 1,
      operationId: 'apply-1',
      requestFingerprint: 'a'.repeat(64),
      planHash: 'plan-1',
      payloadHash: createHash('sha256').update(bytes).digest('hex'),
      payloadByteLength: bytes.length,
      bytes,
      result: { ok: true, summary: 'Applied', warnings: [] },
    })
    expect(await readFile(path)).toEqual(Buffer.from(original))
    expect(await port.readSource(source.sourceContentId)).toEqual(original)
    const reopened = await createDocsDocumentDriver(path, options)
    const bootstrap = (await reopened.bootstrap('http://localhost')) as any
    expect(bootstrap.workingCopy).toMatchObject({
      workingRevision: 2,
      savedRevision: 1,
      checkpointId: receipt.checkpointId,
      dirty: true,
      recoveryState: 'ready',
    })
    expect(bootstrap.contentUrl).toContain('/sources/' + receipt.blobHash + '/content')
    const recovered = await JSZip.loadAsync((await reopened.readContent!()).bytes)
    expect(await recovered.file('word/document.xml')!.async('string')).toContain(
      'Manual edit. Agent edit.',
    )
    expect(await recovered.file('word/header1.xml')!.async('string')).toContain('Manual header')
    await reopened.workingCopy!.store.promoteWorkingCopy({
      documentEpoch: status.documentEpoch,
      expectedSavedRevision: 1,
      expectedWorkingRevision: 2,
      checkpointId: receipt.checkpointId,
      operationId: 'save-1',
      requestFingerprint: 'b'.repeat(64),
      planHash: 'save-plan',
      result: { ok: true, summary: 'Saved', warnings: [] },
    })
    expect(await readFile(path)).toEqual(Buffer.from(bytes))
    expect(await reopened.workingCopy!.store.getStatus()).toMatchObject({
      dirty: false,
      savedRevision: 2,
    })
  }, 20_000)

  it('rejects invalid checkpoint parts before changing either durable file', async () => {
    const { path, bytes } = await fixture()
    const driver = await createDocsDocumentDriver(path, {
      workingCopyRoot: join(directory!, 'recovery'),
    })
    expect(driver.workingCopy).toBeDefined()
    const port = driver.workingCopy!
    const source = await port.acquireSource()
    await expect(
      port.materialize({
        sourceContentId: source.sourceContentId,
        payloadKind: 'docx-bytes',
        parts: new Map([['document', new TextEncoder().encode('broken')]]),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_CONTENT' })
    await expect(
      port.materialize({
        sourceContentId: source.sourceContentId,
        payloadKind: 'docx-bytes',
        parts: new Map([
          ['document', bytes],
          ['surprise', bytes],
        ]),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_CONTENT' })
    expect(await readFile(path)).toEqual(Buffer.from(bytes))
    expect(await port.store.getStatus()).toMatchObject({ workingRevision: 1, dirty: false })
  })
  it('loads a real docx and exposes metadata without embedding bytes in bootstrap', async () => {
    const { path, bytes } = await fixture()
    const driver = await createDocsDocumentDriver(path, {
      workingCopyRoot: join(directory!, 'recovery'),
    })

    const bootstrap = await driver.bootstrap('http://127.0.0.1:43123')
    const content = await driver.readContent!()

    expect(bootstrap).toMatchObject({
      documentId: driver.document.documentId,
      title: basename(path),
      revision: 1,
      websocketUrl: 'ws://127.0.0.1:43123/ws',
      language: 'en',
      theme: 'system',
      contentUrl: expect.stringContaining(`/api/documents/${driver.document.documentId}/sources/`),
    })
    expect(bootstrap).not.toHaveProperty('bytes')
    expect(content.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(content.bytes).toEqual(bytes)
  })

  it('rejects legacy content writes so the recovery baseline cannot be bypassed', async () => {
    const { path } = await fixture()
    const driver = await createDocsDocumentDriver(path, {
      workingCopyRoot: join(directory!, 'recovery'),
    })
    const before = await readFile(path)

    await expect(
      driver.writeContent!(new TextEncoder().encode('not a zip'), 1),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })

    expect(await readFile(path)).toEqual(before)
    expect(driver.document.revision).toBe(1)
    expect((await readdir(directory!)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects concurrent legacy writes without changing the original', async () => {
    const { path } = await fixture()
    const driver = await createDocsDocumentDriver(path, {
      workingCopyRoot: join(directory!, 'recovery'),
    })
    const before = await readFile(path)
    const first = await buildTestDocx('First')
    const second = await buildTestDocx('Second')

    const results = await Promise.allSettled([
      driver.writeContent!(first, 1),
      driver.writeContent!(second, 1),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['rejected', 'rejected'])
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'UNSUPPORTED_CAPABILITY' },
    })
    expect(driver.document.revision).toBe(1)
    expect(await readFile(path)).toEqual(before)
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
