import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString } from 'pdf-lib'
import { afterEach, expect, it } from 'vitest'
import { createPdfDocumentDriver } from '../src/pdf-document-driver'
import { listPageImages } from '../../pdf/src/main/image-edit'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-capabilities-'))
  directories.push(directory)
  const path = join(directory, 'test.pdf')
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400]).drawText('PDF capabilities')
  await writeFile(path, await pdf.save())
  const driver = await createPdfDocumentDriver(path)
  const save = (request: Record<string, unknown>) =>
    driver.execute('save', {
      expectedRevision: driver.document.revision,
      request: { markups: [], drawings: [], formValues: [], stamps: [], ...request },
    })
  const read = async () => PDFDocument.load(await readFile(path))
  return { path, driver, save, read }
}

it('advertises only implemented Web capabilities and gates native actions', async () => {
  const { driver } = await fixture()
  expect(await driver.bootstrap('http://localhost')).toMatchObject({
    capabilities: {
      annotationEditing: true,
      imageEditing: true,
      pageRewriting: true,
      saveAs: false,
      nativeFileDialogs: false,
      permanentRedaction: false,
    },
  })
  for (const action of ['extract-pages', 'replace-pages', 'split-pdf', 'save-as'])
    await expect(driver.execute(action, {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    })
})

it('persists all page rewrites and rejects stale revisions, invalid geometry and supplied paths', async () => {
  const { driver, read, path } = await fixture()
  const modify = (modification: unknown) =>
    driver.execute('modify-pages', { expectedRevision: driver.document.revision, modification })
  await expect(modify({ action: 'insertBlankPage', afterPageIndex: 0 })).resolves.toMatchObject({
    document: { revision: 2 },
  })
  expect((await read()).getPageCount()).toBe(2)
  await modify({ action: 'setPageSize', width: 400, height: 500 })
  expect((await read()).getPages().map((p) => p.getSize())).toEqual([
    { width: 400, height: 500 },
    { width: 400, height: 500 },
  ])
  await modify({ action: 'cropPages', pages: [1], rect: { l: 0.1, t: 0.2, r: 0.9, b: 0.8 } })
  expect((await read()).getPage(1).getCropBox()).toMatchObject({ width: 320, height: 300 })
  expect((await read()).getPage(0).getCropBox()).toMatchObject({ width: 400, height: 500 })
  const before = await readFile(path)
  await expect(
    driver.execute('modify-pages', {
      expectedRevision: 3,
      modification: { action: 'insertBlankPage', afterPageIndex: 0 },
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(
    driver.execute('modify-pages', {
      expectedRevision: 4,
      path: '/other.pdf',
      modification: { action: 'insertBlankPage', afterPageIndex: 0 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(
    modify({ action: 'cropPages', pages: [99], rect: { l: 0, t: 0, r: 1, b: 1 } }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(await readFile(path)).toEqual(before)
  expect(driver.document.revision).toBe(4)
})

it('persists saved note edits/replies/deletion and markup deletion through the save DSL', async () => {
  const { save, read } = await fixture()
  const annots = async () => {
    const pdf = await read()
    return (pdf.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.asArray() ?? []).map(
      (ref) => ({
        objNum: Number(String(ref).split(' ')[0]),
        dict: pdf.context.lookup(ref, PDFDict),
      }),
    )
  }
  const contents = (dict: PDFDict) => {
    const value = dict.lookup(PDFName.of('Contents'))
    if (!(value instanceof PDFString) && !(value instanceof PDFHexString))
      throw new Error('Expected annotation contents')
    return value.decodeText()
  }
  const rectOf = (dict: PDFDict) => dict.lookup(PDFName.of('Rect'), PDFArray).asArray().map(Number)
  await save({
    drawings: [
      { kind: 'note', pageIndex: 0, at: [50, 50], contents: 'Original', color: [1, 1, 0] },
    ],
    markups: [
      {
        pageIndex: 0,
        type: 'highlight',
        color: [1, 1, 0],
        quads: [[10, 20, 40, 20, 10, 10, 40, 10]],
      },
    ],
  })
  const root = (await annots()).find((n) => String(n.dict.get(PDFName.of('Subtype'))) === '/Text')!
  const rect = rectOf(root.dict)
  await save({
    noteEdits: [
      { pageIndex: 0, objNum: root.objNum, rect, oldContents: 'Original', contents: 'Edited' },
    ],
  })
  expect(contents((await annots()).find((n) => n.objNum === root.objNum)!.dict)).toBe('Edited')
  await save({
    drawings: [
      {
        kind: 'note',
        pageIndex: 0,
        at: [50, 50],
        contents: 'Reply',
        color: [1, 1, 0],
        replyToSaved: { objNum: root.objNum, rect, contents: 'Edited' },
      },
    ],
  })
  const items = (await annots()).filter((n) =>
    ['/Text', '/Highlight'].includes(String(n.dict.get(PDFName.of('Subtype')))),
  )
  expect(items.some((n) => String(n.dict.get(PDFName.of('IRT'))) === `${root.objNum} 0 R`)).toBe(
    true,
  )
  await save({
    annotDeletes: items.map((n) => ({
      pageIndex: 0,
      objNum: n.objNum,
      subtype: String(n.dict.get(PDFName.of('Subtype'))) === '/Text' ? 'note' : 'highlight',
      rect: rectOf(n.dict),
      ...(n.dict.has(PDFName.of('Contents')) ? { contents: contents(n.dict) } : {}),
    })),
  })
  expect(
    (await annots()).filter((n) =>
      ['/Text', '/Highlight'].includes(String(n.dict.get(PDFName.of('Subtype')))),
    ),
  ).toHaveLength(0)
})

it('reads real pixels and persists image replacement, rotation, bake replacement and deletion', async () => {
  const { path, driver, save } = await fixture()
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg=='
  const image = async () => (await listPageImages(new Uint8Array(await readFile(path))))[0]!
  const edit = (input: unknown) => save({ imageEdits: [input] })
  await edit({
    kind: 'insertImage',
    pageIndex: 0,
    image: png,
    rect: [10, 20, 110, 70],
    layer: 'aboveText',
  })
  let ref = await image()
  const pixels = (await driver.execute('page-image-png', {
    pageIndex: 0,
    rect: ref.rect,
    scale: 3,
  })) as { png: string }
  expect(pixels.png).toMatch(/^iVBOR/)
  await expect(
    driver.execute('page-image-png', { path: '/other.pdf', pageIndex: 0, rect: ref.rect }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await edit({ kind: 'replaceImage', pageIndex: 0, oldRect: ref.rect, rect: ref.rect, image: png })
  ref = await image()
  await edit({
    kind: 'transformImage',
    pageIndex: 0,
    oldRect: ref.rect,
    rect: [35, 5, 85, 105],
    quarterTurns: 1,
  })
  ref = await image()
  expect(ref.rect.map(Math.round)).toEqual([35, 5, 85, 105])
  await edit({
    kind: 'replaceImage',
    pageIndex: 0,
    oldRect: ref.rect,
    rect: [40, 10, 80, 100],
    image: pixels.png,
  })
  ref = await image()
  expect(ref.rect.map(Math.round)).toEqual([40, 10, 80, 100])
  await edit({ kind: 'deleteImage', pageIndex: 0, oldRect: ref.rect })
  expect(await listPageImages(new Uint8Array(await readFile(path)))).toEqual([])
})
