import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { blankXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { createSheetsDocumentService } from '../src/sheets-document-service'

let directory: string | undefined

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('production Sheets document service', () => {
  it('opens a startup XLSX and returns a browser bootstrap backed by the real sidecar', async () => {
    const currentDirectory = await mkdtemp(join(tmpdir(), 'nexusdesk-document-service-'))
    directory = currentDirectory
    const path = join(currentDirectory, 'Forecast.xlsx')
    await writeFile(path, await blankXlsxBuffer('Summary'))
    const service = await createSheetsDocumentService(resolve(process.cwd(), '../..'), path)

    try {
      expect(service.documents).toEqual([
        expect.objectContaining({ title: 'Forecast.xlsx', editorType: 'sheets', path }),
      ])
      await expect(
        service.documentService.bootstrap(service.documents[0]!, 'http://127.0.0.1:43123'),
      ).resolves.toMatchObject({
        title: 'Forecast.xlsx',
        websocketUrl: 'ws://127.0.0.1:43123/ws',
        workbook: expect.objectContaining({ path, readOnly: false }),
      })
    } finally {
      await service.close()
    }
  })
})
