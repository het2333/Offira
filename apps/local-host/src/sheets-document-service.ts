import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { XlsxSidecarClient } from '../../sheets/src/main/xlsx-sidecar-client'
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
} from '../../sheets/src/shared/desktop-api'
import { saveWorkbookViaSidecar } from '@genoffice/xlsx-gateway/gateway/xlsx-package-io'

import type { LocalDocument, StartLocalHostOptions } from './server'

interface OpenWorkbook {
  file: WorkbookFile
  sheetNames: Map<string, string>
}

function sidecarPath(repositoryRoot: string): string {
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  return resolve(repositoryRoot, 'apps/sheets/native/xlsx-engine/target/release', executable)
}

export async function createSheetsDocumentService(
  repositoryRoot: string,
  path: string,
): Promise<{
  documents: LocalDocument[]
  documentService: NonNullable<StartLocalHostOptions['documentService']>
  close(): Promise<void>
}> {
  const client = new XlsxSidecarClient(sidecarPath(repositoryRoot))
  let opened: OpenWorkbook | undefined
  const document: LocalDocument = {
    documentId: `xlsx-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`,
    title: basename(path),
    editorType: 'sheets',
    revision: 1,
    path,
  }

  const openWorkbook = async (): Promise<OpenWorkbook> => {
    const bytes = await readFile(path)
    const raw = (await client.open(path, 'en')) as Record<string, unknown> & {
      sessionId: string
      sheets: { id: string; name: string }[]
    }
    return {
      file: workbookFileSchema.parse({
        ...raw,
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        fileBytes: (await stat(path)).size,
        readOnly: false,
        needsSaveAs: false,
        restoredFromRecovery: false,
        automaticRecoveryDisabled: false,
      }),
      sheetNames: new Map(raw.sheets.map((sheet) => [sheet.id, sheet.name])),
    }
  }
  const ensureOpen = async (): Promise<OpenWorkbook> => (opened ??= await openWorkbook())
  const sheetName = (state: OpenWorkbook, sheetId: string): string => {
    const name = state.sheetNames.get(sheetId)
    if (name === undefined) throw new Error(`Unknown worksheet ${sheetId}.`)
    return name
  }

  return {
    documents: [document],
    documentService: {
      async bootstrap(current, origin) {
        const state = await ensureOpen()
        return {
          documentId: current.documentId,
          title: current.title,
          revision: current.revision,
          websocketUrl: `${origin.replace(/^http/, 'ws')}/ws`,
          language: 'en',
          theme: 'system',
          workbook: state.file,
        }
      },
      async execute(_current, action, payload) {
        const state = await ensureOpen()
        if (action === 'read-workbook-range') {
          return workbookRangeResultSchema.parse(
            await client.readRange(workbookRangeRequestSchema.parse(payload)),
          )
        }
        if (action === 'read-workbook-formulas') {
          return workbookFormulaCellsResultSchema.parse(
            await client.readFormulaCells(workbookFormulaCellsRequestSchema.parse(payload)),
          )
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
            cells: result.cells.flatMap((cell) => {
              const sheetId = idsByName.get(cell.sheet)
              if (sheetId === undefined) return []
              const { sheet: _sheet, ...rest } = cell
              return [{ ...rest, sheetId }]
            }),
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
            formulaValues: [...new Set(request.formulaValues.map((cell) => cell.sheetId))].map(
              (sheetId) => ({
                sheetName: sheetName(state, sheetId),
                cells: request.formulaValues
                  .filter((cell) => cell.sheetId === sheetId)
                  .map(({ sheetId: _sheetId, ...cell }) => cell),
              }),
            ),
          })
          await client.close(state.file.sessionId)
          opened = await openWorkbook()
          return workbookSaveResultSchema.parse({
            canceled: false,
            file: opened.file,
            touchedEntries: mutation.touchedEntries,
          })
        }
        if (action === 'close-workbook') {
          await client.close(state.file.sessionId)
          opened = undefined
          return { ok: true }
        }
        throw new Error(`Unsupported Sheets document action: ${action}`)
      },
    },
    async close() {
      if (opened !== undefined) await client.close(opened.file.sessionId).catch(() => undefined)
      client.stop()
    },
  }
}
