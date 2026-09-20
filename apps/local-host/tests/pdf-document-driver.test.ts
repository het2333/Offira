import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PDFDocument } from 'pdf-lib'
import { encode as encodeJpeg } from 'jpeg-js'
import { afterEach, describe, expect, it } from 'vitest'

import { createPdfDocumentDriver } from '../src/pdf-document-driver'
import { PDF_WEB_IMAGE_BASE64_LIMIT } from '@nexusdesk/protocol'
import { listPageImages, renderImagePng } from '../../pdf/src/main/image-edit'

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
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) =>
        import('node:fs/promises').then(({ unlink }) => unlink(path).catch(() => undefined)),
      ),
  )
})

describe('PDF Local Document Driver', () => {
  it.each([1, 3])(
    'rejects oversized image payloads (%i images) without disk or revision changes',
    async (count) => {
      const path = await temporaryPdf('size boundary')
      const original = await readFile(path)
      const driver = await createPdfDocumentDriver(path)
      const image = 'A'.repeat(PDF_WEB_IMAGE_BASE64_LIMIT + (count === 1 ? 4 : 0))
      await expect(
        driver.execute('save', {
          expectedRevision: 1,
          request: {
            path: 'nexusdesk://pdf',
            markups: [],
            drawings: [],
            formValues: [],
            stamps: [],
            imageEdits: Array.from({ length: count }, () => ({
              kind: 'insertImage',
              pageIndex: 0,
              image,
              rect: [0, 0, 20, 20],
              layer: 'aboveText',
            })),
          },
        }),
      ).rejects.toMatchObject({ code: 'PDF_PAYLOAD_TOO_LARGE' })
      expect(driver.document.revision).toBe(1)
      expect(await readFile(path)).toEqual(original)
    },
  )
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

    await expect(
      driver.writeContent?.(new TextEncoder().encode('not a PDF'), 1),
    ).rejects.toMatchObject({
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

  it('persists a real PNG image insert without Electron and never reports skipped edits as saved', async () => {
    const path = await temporaryPdf('image insert')
    const driver = await createPdfDocumentDriver(path)

    const result = await driver.execute('save', {
      expectedRevision: 1,
      request: {
        path: 'nexusdesk://pdf',
        markups: [],
        drawings: [],
        formValues: [],
        stamps: [],
        imageEdits: [
          {
            kind: 'insertImage',
            pageIndex: 0,
            image:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==',
            rect: [24, 24, 72, 72],
            layer: 'aboveText',
          },
        ],
      },
    })

    expect(result).toMatchObject({
      document: { revision: 2, editorType: 'pdf' },
      skippedImageEdits: [],
    })
    const savedBytes = new Uint8Array(await readFile(path))
    const images = await listPageImages(savedBytes)
    expect(images).toEqual(expect.arrayContaining([expect.objectContaining({ pageIndex: 0 })]))
    await expect(renderImagePng(savedBytes, 0, images[0]!.rect)).resolves.toMatch(/^iVBORw0KGgo/)
  })

  it('persists a real JPEG image insert without Electron', async () => {
    const path = await temporaryPdf('jpeg image insert')
    const driver = await createPdfDocumentDriver(path)
    const jpeg = encodeJpeg(
      {
        data: Buffer.from([255, 0, 0, 255]),
        width: 1,
        height: 1,
      },
      80,
    ).data.toString('base64')

    await expect(
      driver.execute('save', {
        expectedRevision: 1,
        request: {
          path: 'nexusdesk://pdf',
          markups: [],
          drawings: [],
          formValues: [],
          stamps: [],
          imageEdits: [
            {
              kind: 'insertImage',
              pageIndex: 0,
              image: jpeg,
              rect: [24, 24, 72, 72],
              layer: 'aboveText',
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ document: { revision: 2 }, skippedImageEdits: [] })
    expect(await listPageImages(new Uint8Array(await readFile(path)))).toEqual(
      expect.arrayContaining([expect.objectContaining({ pageIndex: 0 })]),
    )
  })

  it('persists an ASCII text insert through PDF standard Helvetica without a machine font', async () => {
    const path = await temporaryPdf('standard text insert')
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
          textInserts: [
            { pageIndex: 0, origin: [36, 36], text: 'NexusDesk', fontSize: 12, color: [0, 0, 0] },
          ],
        },
      }),
    ).resolves.toMatchObject({ document: { revision: 2 }, skippedTextInserts: [] })
    expect(await readFile(path, 'utf8')).toContain('/Helvetica')
  })

  it('rejects every partially skipped save without replacing the authorized file', async () => {
    const path = await temporaryPdf('partial save')
    const original = await readFile(path)
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
          textInserts: [
            {
              pageIndex: 99,
              origin: [24, 24],
              text: 'must not be silently skipped',
              fontSize: 12,
              color: [0, 0, 0],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'PDF_SAVE_INCOMPLETE' })
    expect(await readFile(path)).toEqual(original)
    expect(driver.document.revision).toBe(1)
  })
})
