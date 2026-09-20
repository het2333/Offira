import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PDFDocument, PDFArray, PDFDict, PDFName, PDFHexString, PDFString } from 'pdf-lib'
import { encode as encodeJpeg } from 'jpeg-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPdfDocumentDriver as createDriver } from '../src/pdf-document-driver'
import { capturePdfWorkingCopy } from '../../pdf/src/renderer/agent/pdf-working-copy'
import type { SavePdfRequest } from '../../pdf/src/shared/ipc'
import { WorkingCopyCoordinator } from '../src/working-copy-coordinator'
import { DocumentDriverRegistry } from '../src/document-driver'
import { DocumentRegistry } from '../src/document-registry'
import type { EditorRegisterFrame, EditorRequestFrame } from '@nexusdesk/protocol'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
})
import { PDF_WEB_IMAGE_BASE64_LIMIT } from '@nexusdesk/protocol'
import { listPageImages, renderImagePng } from '../../pdf/src/main/image-edit'

const temporaryPaths: string[] = []
const temporaryDirectories: string[] = []
async function createPdfDocumentDriver(
  path: string,
  options: Parameters<typeof createDriver>[1] = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-working-copy-'))
  temporaryDirectories.push(directory)
  return createDriver(path, { workingCopyRoot: directory, ...options })
}
const emptySave = (overrides: Partial<SavePdfRequest> = {}): SavePdfRequest => ({
  path: '',
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  ...overrides,
})
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg=='
async function materialize(
  driver: Awaited<ReturnType<typeof createDriver>>,
  sourceContentId: string,
  request: SavePdfRequest,
) {
  const payload = capturePdfWorkingCopy(request)
  const parts = new Map(
    await Promise.all(
      [...payload.parts].map(
        async ([key, value]) => [key, new Uint8Array(await value.arrayBuffer())] as const,
      ),
    ),
  )
  return driver.workingCopy!.materialize({ sourceContentId, payloadKind: payload.kind, parts })
}
async function checkpoint(
  driver: Awaited<ReturnType<typeof createDriver>>,
  bytes: Uint8Array,
  operationId: string,
) {
  const status = await driver.workingCopy!.store.getStatus()
  return driver.workingCopy!.store.commitCheckpoint({
    documentEpoch: status.documentEpoch,
    expectedSavedRevision: status.savedRevision,
    expectedWorkingRevision: status.workingRevision,
    operationId,
    requestFingerprint: operationId,
    planHash: operationId,
    bytes,
    payloadByteLength: bytes.byteLength,
    payloadHash: createHash('sha256').update(bytes).digest('hex'),
    result: { ok: true, summary: operationId, warnings: [] },
  })
}
async function annotations(bytes: Uint8Array, pageIndex = 0) {
  const pdf = await PDFDocument.load(bytes)
  const values = pdf.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  return Array.from({ length: values?.size() ?? 0 }, (_, i) => {
    const ref = values!.get(i)
    const dict = pdf.context.lookup(ref, PDFDict)
    const contents = dict.get(PDFName.of('Contents'))
    return {
      ref,
      subtype: String(dict.get(PDFName.of('Subtype'))),
      rect: dict.lookup(PDFName.of('Rect'), PDFArray).asArray().map(Number),
      contents:
        contents instanceof PDFHexString || contents instanceof PDFString
          ? contents.decodeText()
          : '',
    }
  })
}

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
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.open).mockImplementation(actual.open)
  vi.mocked(fs.rename).mockImplementation(actual.rename)
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) =>
        import('node:fs/promises').then(({ unlink }) => unlink(path).catch(() => undefined)),
      ),
  )
})

describe('PDF Local Document Driver', () => {
  it('promotes a recovered PDF with no new edits without another working revision', async () => {
    const path = await temporaryPdf('original')
    const driver = await createPdfDocumentDriver(path)
    const original = await readFile(path)
    const source = await driver.workingCopy!.acquireSource()
    const changed = await materialize(
      driver,
      source.sourceContentId,
      emptySave({ metadata: { title: 'Recovered' } }),
    )
    await checkpoint(driver, changed, 'apply')
    const root = await mkdtemp(join(tmpdir(), 'pdf-save-upload-'))
    temporaryDirectories.push(root)
    const coordinator = new WorkingCopyCoordinator({
      drivers: new DocumentDriverRegistry([driver]),
      documents: new DocumentRegistry([driver.document]),
      uploadRoot: root,
    })
    const state = await coordinator.bootstrap(
      driver.document.documentId,
      'http://localhost',
      'session',
    )
    await coordinator.register(
      {
        type: 'editor:register',
        protocolVersion: 1,
        id: 'register',
        clientId: 'client',
        rendererInstanceId: 'new-renderer',
        documentId: driver.document.documentId,
        editorType: 'pdf',
        revision: 2,
        documentEpoch: state.documentEpoch,
        sourceContentId: state.sourceContentId,
        restoredCheckpointId: state.checkpointId,
      } as EditorRegisterFrame,
      'session',
    )
    const payload = capturePdfWorkingCopy(emptySave())
    const parts = new Map(
      await Promise.all(
        [...payload.parts].map(
          async ([key, blob]) => [key, new Uint8Array(await blob.arrayBuffer())] as const,
        ),
      ),
    )
    expect(await readFile(path)).toEqual(original)
    const saved = await coordinator.saveManual({
      documentId: driver.document.documentId,
      clientId: 'client',
      documentEpoch: state.documentEpoch,
      sourceContentId: state.sourceContentId,
      operationId: 'manual',
      expectedWorkingRevision: 2,
      expectedSavedRevision: 1,
      payloadKind: 'pdf-save-plan',
      parts,
    })
    expect(saved.persistence).toMatchObject({ dirty: false, workingRevision: 2, savedRevision: 2 })
    expect(new Uint8Array(await readFile(path))).toEqual(changed)
    expect((await PDFDocument.load(await readFile(path))).getTitle()).toBe('Recovered')
    await coordinator.close()
  })
  it.each(['intent', 'rename', 'receipt'] as const)(
    'recovers an approved page rewrite after a %s interruption with one inserted page',
    async (stage) => {
      const path = await temporaryPdf('rewrite')
      const root = await mkdtemp(join(tmpdir(), 'pdf-rewrite-'))
      temporaryDirectories.push(root)
      const driver = await createDriver(path, { workingCopyRoot: join(root, 'recovery') })
      const coordinator = new WorkingCopyCoordinator({
        drivers: new DocumentDriverRegistry([driver]),
        documents: new DocumentRegistry([driver.document]),
        uploadRoot: join(root, 'uploads'),
      })
      const state = await coordinator.bootstrap(
        driver.document.documentId,
        'http://localhost',
        'session',
      )
      await coordinator.register(
        {
          type: 'editor:register',
          protocolVersion: 1,
          id: 'register',
          clientId: 'client',
          rendererInstanceId: 'renderer',
          documentId: driver.document.documentId,
          editorType: 'pdf',
          revision: 1,
          documentEpoch: state.documentEpoch,
          sourceContentId: state.sourceContentId,
          restoredCheckpointId: null,
        } as EditorRegisterFrame,
        'session',
      )
      const frame = {
        type: 'editor:request',
        protocolVersion: 1,
        id: 'request',
        command: 'apply_ops',
        target: {
          documentId: driver.document.documentId,
          editorType: 'pdf',
          clientId: 'client',
          sessionId: 'turn',
          operationId: 'rewrite',
          revision: 1,
        },
        arguments: {},
        approval: { id: 'approved', planHash: 'page-plan' },
      } as unknown as EditorRequestFrame
      const fingerprint = await coordinator.reserve(frame, { inPlaceRewrite: true })
      const created = await coordinator.beginUpload(driver.document.documentId, 'client', {
        schemaVersion: 1,
        requestId: frame.id,
        clientId: frame.target.clientId,
        documentEpoch: state.documentEpoch,
        operationId: frame.target.operationId,
        expectedWorkingRevision: 1,
        expectedSavedRevision: 1,
        sourceContentId: state.sourceContentId,
        planHash: 'page-plan',
        result: { ok: true, summary: 'Inserted blank page', warnings: [] },
        payloadKind: 'pdf-save-plan',
      })
      const payload = capturePdfWorkingCopy(
        emptySave({
          drawings: [
            {
              kind: 'note',
              pageIndex: 0,
              color: [1, 0, 0],
              at: [20, 20],
              contents: 'pending before rewrite',
            },
          ],
        }),
        { action: 'insertBlankPage', afterPageIndex: 0 },
      )
      const parts = []
      for (const [id, blob] of payload.parts)
        parts.push(
          await coordinator.putPart(driver.document.documentId, 'client', created.uploadId, id, [
            new Uint8Array(await blob.arrayBuffer()),
          ]),
        )
      const actual = await vi.importActual<typeof fs>('node:fs/promises')
      let publications = 0
      let replaced = false
      vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
        await actual.rename(source, destination)
        if (String(destination).endsWith('/manifest.json')) publications++
        if (String(destination) === path) replaced = true
      })
      vi.mocked(fs.open).mockImplementation(async (file, ...args) => {
        const handle = await actual.open(file, ...args)
        if (
          (stage === 'intent' && publications >= 2) ||
          (stage === 'rename' && replaced) ||
          (stage === 'receipt' && publications >= 3)
        ) {
          if ((await handle.stat()).isDirectory())
            handle.sync = async () => {
              throw Error('simulated crash before durable acknowledgement')
            }
        }
        return handle
      })
      await expect(
        coordinator.commitUpload(driver.document.documentId, 'client', created.uploadId, parts),
      ).rejects.toMatchObject({ code: 'WORKING_COPY_OUTCOME_UNKNOWN' })
      vi.mocked(fs.open).mockImplementation(actual.open)
      vi.mocked(fs.rename).mockImplementation(actual.rename)
      const reopened = await createDriver(path, { workingCopyRoot: join(root, 'recovery') })
      const receipt = await reopened.workingCopy!.store.lookupTerminal('rewrite', fingerprint)
      expect(receipt).toMatchObject({
        dirty: false,
        savedRevision: 2,
        binding: { command: 'apply_ops' },
      })
      expect((await PDFDocument.load(await readFile(path))).getPageCount()).toBe(2)
      expect(
        (await annotations(new Uint8Array(await readFile(path)))).filter(
          (a) => a.contents === 'pending before rewrite',
        ),
      ).toHaveLength(1)
      expect(await reopened.workingCopy!.store.lookupTerminal('rewrite', fingerprint)).toEqual(
        receipt,
      )
      expect((await PDFDocument.load(await readFile(path))).getPageCount()).toBe(2)
      await coordinator.close()
    },
  )
  it('reads static form metadata from the same recovered source used for page edits', async () => {
    const path = await temporaryPdf('forms')
    const driver = await createPdfDocumentDriver(path)
    const source = await driver.workingCopy!.acquireSource()
    const bytes = await materialize(
      driver,
      source.sourceContentId,
      emptySave({
        staticFormFills: [
          { id: 'form', kind: 'text', pageIndex: 0, rect: [1, 1, 20, 20], text: 'Ada' },
        ],
      }),
    )
    await checkpoint(driver, bytes, 'form')
    const recovered = await driver.workingCopy!.acquireSource()
    expect(
      await driver.execute('list-static-form-fills', {
        sourceContentId: recovered.sourceContentId,
      }),
    ).toEqual({
      fills: [{ id: 'form', kind: 'text', pageIndex: 0, rect: [1, 1, 20, 20], text: 'Ada' }],
    })
    expect(
      await driver.execute('list-static-form-fills', { sourceContentId: source.sourceContentId }),
    ).toEqual({ fills: [] })
  })
  it('keeps cumulative A→B and A→reload→B plans source-bound with real text, annotations, forms, pages and images', async () => {
    const path = await temporaryPdf('original')
    const initial = await PDFDocument.create()
    const first = initial.addPage([300, 400])
    initial.addPage([300, 400])
    initial.addPage([300, 400])
    initial
      .getForm()
      .createTextField('Name')
      .addToPage(first, { x: 10, y: 330, width: 100, height: 20 })
    await writeFile(path, await initial.save())
    const original = await readFile(path)
    const driver = await createPdfDocumentDriver(path)
    const source = await driver.workingCopy!.acquireSource()
    const plan = emptySave({
      drawings: [{ kind: 'note', pageIndex: 0, color: [1, 0, 0], at: [20, 100], contents: 'A' }],
      textInserts: [
        { pageIndex: 0, origin: [40, 200], text: 'Manual', fontSize: 12, color: [0, 0, 0] },
      ],
      markups: [
        {
          pageIndex: 0,
          type: 'highlight',
          color: [1, 1, 0],
          quads: [[40, 212, 80, 212, 40, 200, 80, 200]],
        },
      ],
      imageEdits: [
        {
          kind: 'insertImage',
          pageIndex: 0,
          image: png,
          rect: [10, 10, 30, 30],
          layer: 'aboveText',
        },
      ],
      stamps: [{ pageIndex: 0, image: png, rect: [40, 10, 60, 30] }],
      formValues: [{ name: 'Name', kind: 'text', value: 'Ada' }],
      rotations: [{ pageIndex: 0, delta: 90 }],
      deletedPages: [1],
      pageOrder: [2, 0],
      metadata: { title: 'A' },
    })
    const a = await materialize(driver, source.sourceContentId, plan)
    const receiptA = await checkpoint(driver, a, 'A')
    const b = await materialize(driver, source.sourceContentId, {
      ...plan,
      metadata: { title: 'B' },
    })
    await checkpoint(driver, b, 'B')
    const pdf = await PDFDocument.load(b)
    expect(pdf.getPageCount()).toBe(2)
    expect(pdf.getPage(1).getRotation().angle).toBe(90)
    expect(pdf.getTitle()).toBe('B')
    expect(pdf.getForm().getTextField('Name').getText()).toBe('Ada')
    expect((await annotations(b, 1)).filter((a) => a.contents === 'A')).toHaveLength(1)
    expect((await annotations(b, 1)).filter((a) => a.subtype === '/Highlight')).toHaveLength(1)
    expect((await listPageImages(b)).filter((image) => image.pageIndex === 1)).toHaveLength(2)
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const parsed = await getDocument({ data: b.slice(), useSystemFonts: true }).promise
    const text = await (await parsed.getPage(2)).getTextContent()
    expect(
      text.items.map((item) => ('str' in item ? item.str : '')).filter((item) => item === 'Manual'),
    ).toHaveLength(1)
    await parsed.loadingTask.destroy()
    expect(await driver.workingCopy!.store.lookupTerminal('A', 'A')).toEqual(receiptA)
    expect((await driver.workingCopy!.store.getStatus()).workingRevision).toBe(3)
    const recovered = await driver.workingCopy!.acquireSource()
    const root = (await annotations(recovered.bytes, 1)).find((a) => a.contents === 'A')!
    const changed = await materialize(
      driver,
      recovered.sourceContentId,
      emptySave({
        noteEdits: [
          {
            pageIndex: 1,
            objNum: (root.ref as any).objectNumber,
            rect: root.rect as [number, number, number, number],
            oldContents: 'A',
            contents: 'Recovered note',
          },
        ],
        metadata: { title: 'C' },
      }),
    )
    expect(
      (await annotations(changed, 1)).filter((a) => a.contents === 'Recovered note'),
    ).toHaveLength(1)
    expect((await PDFDocument.load(changed)).getPage(1).getRotation().angle).toBe(90)
    const removed = await materialize(
      driver,
      recovered.sourceContentId,
      emptySave({
        annotDeletes: [
          {
            pageIndex: 1,
            objNum: (root.ref as any).objectNumber,
            subtype: 'note',
            rect: root.rect as [number, number, number, number],
            contents: 'A',
          },
        ],
      }),
    )
    expect((await annotations(removed, 1)).filter((a) => a.subtype === '/Text')).toHaveLength(0)
    expect((await annotations(removed, 1)).filter((a) => a.subtype === '/Highlight')).toHaveLength(
      1,
    )
    expect(await driver.readContent!()).toMatchObject({ bytes: b })
    expect(
      await driver.execute('list-page-images', { sourceContentId: source.sourceContentId }),
    ).toEqual({ images: [] })
    expect(
      (
        (await driver.execute('list-page-images', {
          sourceContentId: recovered.sourceContentId,
        })) as any
      ).images,
    ).toHaveLength(2)
    expect(
      await driver.execute('page-image-png', {
        sourceContentId: recovered.sourceContentId,
        pageIndex: 1,
        rect: [10, 10, 30, 30],
      }),
    ).toMatchObject({ png: expect.stringMatching(/^iVBOR/) })
    expect(await readFile(path)).toEqual(original)
  }, 20_000)

  it.each(['skippedTextEdits', 'skippedTextInserts', 'skippedImageEdits'] as const)(
    'rejects checkpoint materialization with %s before any terminal',
    async (skipped) => {
      const path = await temporaryPdf('original')
      const driver = await createPdfDocumentDriver(path, {
        applySaveRequest: async (bytes) => ({
          bytes,
          skippedTextEdits: [],
          skippedTextInserts: [],
          skippedImageEdits: [],
          [skipped]: [{ pageIndex: 0, reason: 'unmatched' }],
        }),
      })
      const source = await driver.workingCopy!.acquireSource()
      await expect(
        materialize(
          driver,
          source.sourceContentId,
          emptySave({ metadata: { title: 'must fail' } }),
        ),
      ).rejects.toMatchObject({ code: 'PDF_SAVE_INCOMPLETE' })
      expect(await driver.workingCopy!.store.getStatus()).toMatchObject({
        dirty: false,
        head: null,
        workingRevision: 1,
      })
    },
  )
  it('materializes cumulative pending edits from an immutable source without changing the original', async () => {
    const path = await temporaryPdf('fixed source')
    const driver = await createPdfDocumentDriver(path)
    expect(driver.workingCopy).toBeDefined()
    if (!driver.workingCopy) return
    const original = await readFile(path)
    const source = await driver.workingCopy.acquireSource()
    const { capturePdfWorkingCopy } = await import('../../pdf/src/renderer/agent/pdf-working-copy')
    const payload = capturePdfWorkingCopy({
      path: 'nexusdesk://pdf',
      markups: [],
      drawings: [{ kind: 'note', pageIndex: 0, color: [1, 0, 0], at: [20, 20], contents: 'A' }],
      formValues: [],
      stamps: [],
      textInserts: [
        { pageIndex: 0, origin: [40, 40], text: 'Manual', fontSize: 12, color: [0, 0, 0] },
      ],
      rotations: [{ pageIndex: 0, delta: 90 }],
      metadata: { title: 'B' },
    })
    const parts = new Map(
      await Promise.all(
        [...payload.parts].map(
          async ([key, value]) => [key, new Uint8Array(await value.arrayBuffer())] as const,
        ),
      ),
    )
    const bytes = await driver.workingCopy.materialize({
      sourceContentId: source.sourceContentId,
      payloadKind: payload.kind,
      parts,
    })
    const parsed = await PDFDocument.load(bytes)
    expect(parsed.getTitle()).toBe('B')
    expect(parsed.getPage(0).getRotation().angle).toBe(90)
    expect(await readFile(path)).toEqual(original)
    expect(await driver.workingCopy.readSource(source.sourceContentId)).toEqual(
      new Uint8Array(original),
    )
  })
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
