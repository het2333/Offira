import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PDFDocument } from 'pdf-lib'
import { afterEach, describe, expect, it } from 'vitest'

import { createPdfDocumentDriver } from '../src/pdf-document-driver'

const temporaryPaths: string[] = []

async function pdfBytes(label: string): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  document.addPage().drawText(label)
  return document.save()
}

async function temporaryPdf(label: string): Promise<string> {
  const path = join(tmpdir(), `nexusdesk-pdf-driver-${crypto.randomUUID()}.pdf`)
  temporaryPaths.push(path)
  await writeFile(path, await pdfBytes(label))
  return path
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => import('node:fs/promises').then(({ unlink }) => unlink(path).catch(() => undefined))))
})

describe('PDF Local Document Driver', () => {
  it('serves only the authorized PDF and persists a revision-checked working copy', async () => {
    const path = await temporaryPdf('before')
    const driver = await createPdfDocumentDriver(path)

    const bootstrap = await driver.bootstrap('http://127.0.0.1:4312')
    expect(bootstrap).toMatchObject({
      documentId: driver.document.documentId,
      title: 'nexusdesk-pdf-driver-' + path.split('nexusdesk-pdf-driver-')[1],
      revision: 1,
      websocketUrl: 'ws://127.0.0.1:4312/ws',
      contentUrl: `/api/documents/${encodeURIComponent(driver.document.documentId)}/content`,
      capabilities: expect.objectContaining({ saveInPlace: true, textReflow: false }),
    })

    const updated = await pdfBytes('after')
    await expect(driver.writeContent?.(updated, 1)).resolves.toMatchObject({
      documentId: driver.document.documentId,
      editorType: 'pdf',
      revision: 2,
    })
    expect(new Uint8Array(await readFile(path))).toEqual(updated)
    await expect(driver.writeContent?.(await pdfBytes('stale'), 1)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    })
  })

  it('rejects invalid replacement bytes without advancing the revision', async () => {
    const path = await temporaryPdf('original')
    const original = await readFile(path)
    const driver = await createPdfDocumentDriver(path)

    await expect(driver.writeContent?.(new TextEncoder().encode('not a PDF'), 1)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_CONTENT',
    })
    expect(await readFile(path)).toEqual(original)
    expect(driver.document.revision).toBe(1)
  })

  it('applies a browser save through the authorized Host working copy', async () => {
    const path = await temporaryPdf('original')
    const driver = await createPdfDocumentDriver(path)

    await expect(
      driver.execute('save', {
        expectedRevision: 1,
        request: {
          path: 'nexusdesk://pdf',
          markups: [],
          drawings: [],
          formValues: [],
          stamps: [],
          metadata: { title: 'Saved by Local Host' },
        },
      }),
    ).resolves.toMatchObject({ document: { revision: 2, editorType: 'pdf' } })
    const saved = await PDFDocument.load(await readFile(path))
    expect(saved.getTitle()).toBe('Saved by Local Host')
  })
})
