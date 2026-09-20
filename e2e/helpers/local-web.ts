import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { DocumentDriverRegistry } from '../../apps/local-host/src/document-driver'
import { startLocalHost } from '../../apps/local-host/src/server'
import { XlsxSidecarClient } from '../../apps/sheets/src/main/xlsx-sidecar-client'
import {
  workbookFileSchema,
  workbookFormulaCellsRequestSchema,
  workbookFormulaCellsResultSchema,
  workbookRangeRequestSchema,
  workbookRangeResultSchema,
  workbookRecalcRequestSchema,
  workbookRecalcResultSchema,
  workbookSaveRequestSchema,
  workbookSaveResultSchema,
  type WorkbookFile,
} from '../../apps/sheets/src/shared/desktop-api'
import { blankXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { saveWorkbookViaSidecar } from '@genoffice/xlsx-gateway/gateway/xlsx-package-io'
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib'
import { createPdfDocumentDriver } from '../../apps/local-host/src/pdf-document-driver'
import { startLocalPdfProvider } from './local-pdf-provider'

interface OpenWorkbook {
  file: WorkbookFile
  sheetNames: Map<string, string>
}

async function workbookFile(client: XlsxSidecarClient, path: string): Promise<OpenWorkbook> {
  const bytes = await readFile(path)
  const opened = (await client.open(path, 'en')) as Record<string, unknown> & {
    sessionId: string
    sheets: { id: string; name: string }[]
  }
  return {
    file: workbookFileSchema.parse({
      ...opened,
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      fileBytes: (await stat(path)).size,
      readOnly: false,
      needsSaveAs: false,
      restoredFromRecovery: false,
      automaticRecoveryDisabled: false,
    }),
    sheetNames: new Map(opened.sheets.map((sheet) => [sheet.id, sheet.name])),
  }
}

async function seedWorkbook(client: XlsxSidecarClient, path: string): Promise<void> {
  await writeFile(path, await blankXlsxBuffer('Summary'))
  await saveWorkbookViaSidecar({
    client,
    sourcePath: path,
    targetPath: path,
    edits: [
      { sheetName: 'Summary', row: 0, column: 0, writeValue: true, cell: { value: 'Quarter' } },
      { sheetName: 'Summary', row: 0, column: 1, writeValue: true, cell: { value: 'Revenue' } },
      { sheetName: 'Summary', row: 1, column: 0, writeValue: true, cell: { value: 'Q1' } },
      { sheetName: 'Summary', row: 1, column: 1, writeValue: true, cell: { value: 12 } },
      { sheetName: 'Summary', row: 2, column: 0, writeValue: true, cell: { value: 'Q2' } },
      { sheetName: 'Summary', row: 2, column: 1, writeValue: true, cell: { value: 18 } },
    ],
  })
}

function sidecarPath(repositoryRoot: string): string {
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  return resolve(repositoryRoot, 'apps/sheets/native/xlsx-engine/target/release', executable)
}

export async function launchLocalWebHost() {
  const repositoryRoot = process.cwd()
  if (!existsSync(resolve(repositoryRoot, 'apps/web/dist/index.html'))) {
    execFileSync('npm', ['run', 'build:web'], { cwd: repositoryRoot, stdio: 'inherit' })
  }
  const directory = await mkdtemp(join(tmpdir(), 'nexusdesk-local-web-e2e-'))
  const path = join(directory, 'Forecast.xlsx')
  const applyCountPath = join(directory, 'apply-count.json')
  const client = new XlsxSidecarClient(sidecarPath(repositoryRoot))
  await seedWorkbook(client, path)
  let opened: OpenWorkbook | undefined

  const ensureOpen = async (): Promise<OpenWorkbook> => {
    opened ??= await workbookFile(client, path)
    return opened
  }
  const sheetName = (state: OpenWorkbook, sheetId: string): string => {
    const name = state.sheetNames.get(sheetId)
    if (name === undefined) throw new Error(`Unknown worksheet ${sheetId}.`)
    return name
  }

  const running = await startLocalHost({
    staticAssets: {
      webRoot: resolve(repositoryRoot, 'apps/web/dist'),
      editorRoots: {
        sheets: resolve(repositoryRoot, 'apps/sheets/out/web'),
      },
    },
    documentDrivers: new DocumentDriverRegistry([
      {
        document: {
          documentId: 'document-1',
          title: 'Forecast.xlsx',
          editorType: 'sheets',
          revision: 1,
        },
        async bootstrap(origin) {
          const state = await ensureOpen()
          return {
            documentId: 'document-1',
            title: 'Forecast.xlsx',
            revision: 1,
            websocketUrl: `${origin.replace(/^http/, 'ws')}/ws`,
            language: 'en',
            theme: 'light',
            workbook: state.file,
          }
        },
        async execute(action, payload) {
          const state = await ensureOpen()
          if (action === 'read-workbook-range') {
            const request = workbookRangeRequestSchema.parse(payload)
            return workbookRangeResultSchema.parse(await client.readRange(request))
          }
          if (action === 'read-workbook-formulas') {
            const request = workbookFormulaCellsRequestSchema.parse(payload)
            return workbookFormulaCellsResultSchema.parse(await client.readFormulaCells(request))
          }
          if (action === 'recalculate-workbook') {
            const request = workbookRecalcRequestSchema.parse(payload)
            const result = (await client.recalcCells({
              path,
              edits: request.edits.map((edit) => ({
                sheet: sheetName(state, edit.sheetId),
                row: edit.row,
                column: edit.column,
                input: edit.input,
              })),
              reads: request.reads.map((read) => ({
                sheet: sheetName(state, read.sheetId),
                range: read.range,
              })),
            })) as { cells: Array<Record<string, unknown> & { sheet: string }> }
            const idsByName = new Map([...state.sheetNames].map(([id, name]) => [name, id]))
            return workbookRecalcResultSchema.parse({
              cells: result.cells
                .flatMap((cell) => {
                  const sheetId = idsByName.get(cell.sheet)
                  return sheetId === undefined ? [] : [{ ...cell, sheetId, sheet: undefined }]
                })
                .map(({ sheet: _sheet, ...cell }) => cell),
            })
          }
          if (action === 'save-workbook') {
            const request = workbookSaveRequestSchema.parse(payload)
            const mutation = await saveWorkbookViaSidecar({
              client,
              sourcePath: path,
              targetPath: path,
              edits: request.edits.map((edit) => ({
                sheetName: sheetName(state, edit.sheetId),
                row: edit.row,
                column: edit.column,
                writeValue: edit.writeValue,
                cell: { value: edit.value, formula: edit.formula },
                style: edit.style,
                rich: edit.rich,
                styleReset: edit.styleReset,
              })),
              bulkConstantFills: (request.bulkConstantFills ?? []).map(({ sheetId, ...fill }) => ({
                sheetName: sheetName(state, sheetId),
                ...fill,
              })),
              chartEdits: request.chartEdits,
              visualEdits: request.visualEdits,
              visualAdditions: request.visualAdditions.map(({ sheetId, ...addition }) => ({
                sheetName: sheetName(state, sheetId),
                ...addition,
              })),
              formulaValues:
                request.formulaValues.length === 0
                  ? []
                  : [
                      ...new Map(
                        request.formulaValues.map((cell) => [
                          sheetName(state, cell.sheetId),
                          [] as typeof request.formulaValues,
                        ]),
                      ),
                    ].map(([name]) => ({
                      sheetName: name,
                      cells: request.formulaValues
                        .filter((cell) => sheetName(state, cell.sheetId) === name)
                        .map(({ sheetId: _sheetId, ...cell }) => cell),
                    })),
            })
            await client.close(state.file.sessionId)
            opened = await workbookFile(client, path)
            return workbookSaveResultSchema.parse({
              canceled: false,
              file: opened.file,
              touchedEntries: mutation.touchedEntries,
            })
          }
          if (action === 'close-workbook') {
            const sessionId =
              typeof payload === 'object' && payload !== null
                ? (payload as { sessionId?: unknown }).sessionId
                : undefined
            if (sessionId === state.file.sessionId) {
              await client.close(state.file.sessionId)
              opened = undefined
            }
            return { ok: true }
          }
          throw new Error(`Unsupported E2E document action: ${action}`)
        },
        async close() {},
      },
    ]),
    runtimeCommand: {
      entry: resolve(repositoryRoot, 'e2e/fixtures/fake-harness-runtime.mjs'),
      args: [applyCountPath],
    },
  })

  return {
    ...running,
    async readApplyCount() {
      const state = JSON.parse(await readFile(applyCountPath, 'utf8')) as { applyCount: number }
      return state.applyCount
    },
    async readFinalWorkbook() {
      const cli = resolve(repositoryRoot, 'packages/cli/dist/genoffice.cjs')
      if (!existsSync(cli)) {
        execFileSync('npm', ['run', 'build', '-w', '@genoffice/cli'], {
          cwd: repositoryRoot,
          stdio: 'inherit',
        })
      }
      const output = execFileSync(
        process.execPath,
        [cli, 'sheet', 'read', path, '--sheet', 'Summary', '--range', 'A1:B4', '--json'],
        { cwd: repositoryRoot, encoding: 'utf8' },
      )
      const result = JSON.parse(output) as {
        status: string
        detail: {
          rows: unknown[][]
          formulas: Record<string, string>
          features: { charts: Array<{ title: string; types: string[] }> }
        }
      }
      if (result.status !== 'ok') throw new Error(`CLI reader failed: ${output}`)
      return {
        rows: result.detail.rows,
        formulas: result.detail.formulas,
        charts: result.detail.features.charts,
      }
    },
    async close() {
      await running.close()
      if (opened !== undefined) await client.close(opened.file.sessionId).catch(() => undefined)
      client.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** Real PDF Local Web fixture: the disk file is owned only by the Local Host driver. */
export async function launchPdfLocalWebHost(options: { realRuntime?: boolean } = {}) {
  const repositoryRoot = process.cwd()
  if (!existsSync(resolve(repositoryRoot, 'apps/web/dist/index.html'))) {
    execFileSync('npm', ['run', 'build:web'], { cwd: repositoryRoot, stdio: 'inherit' })
  }
  const directory = await mkdtemp(join(tmpdir(), 'nexusdesk-local-web-pdf-e2e-'))
  const path = join(directory, 'Review.pdf')
  const applyCountPath = join(directory, 'apply-count.json')
  const pdf = await PDFDocument.create()
  pdf.addPage([612, 792]).drawText('NexusDesk approval target', { x: 72, y: 700, size: 18 })
  await writeFile(path, await pdf.save())
  const driver = await createPdfDocumentDriver(path)
  const original = await readFile(path)
  const provider = options.realRuntime ? await startLocalPdfProvider(directory) : undefined
  const running = await startLocalHost({
    staticAssets: {
      webRoot: resolve(repositoryRoot, 'apps/web/dist'),
      editorRoots: { pdf: resolve(repositoryRoot, 'apps/pdf/out/web') },
    },
    runtimeCommand: provider?.runtimeCommand ?? {
      entry: resolve(repositoryRoot, 'e2e/fixtures/fake-pdf-harness-runtime.mjs'),
      args: [applyCountPath],
    },
    documentDrivers: new DocumentDriverRegistry([driver]),
  })

  return {
    ...running,
    providerRequests: provider?.requests,
    async readApplyCount() {
      const state = JSON.parse(await readFile(applyCountPath, 'utf8')) as { applyCount: number }
      return state.applyCount
    },
    async inspectDiskPdf() {
      const bytes = await readFile(path)
      const saved = await PDFDocument.load(bytes)
      const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const loadingTask = getDocument({ data: new Uint8Array(bytes), disableWorker: true })
      const rendered = await loadingTask.promise
      const text = await (
        await rendered.getPage(1)
      )
        .getTextContent()
        .then((content) => content.items.map((item) => ('str' in item ? item.str : '')).join(''))
      await loadingTask.destroy()
      return {
        changed: !bytes.equals(original),
        annotationCount: annots?.size() ?? 0,
        text,
        pageCount: saved.getPageCount(),
        pageSizes: saved.getPages().map((p) => p.getSize()),
        cropBoxes: saved.getPages().map((p) => p.getCropBox()),
      }
    },
    async close() {
      await running.close()
      await provider?.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
