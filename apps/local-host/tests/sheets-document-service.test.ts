import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSheetsDocumentService } from '../src/sheets-document-service'
import { encodeWorkbookSaveRequest } from '../../sheets/src/shared/workbook-save-plan'
import type { WorkbookFile, WorkbookSaveRequest } from '../../sheets/src/shared/desktop-api'
import { buildEditFixture } from '../../sheets/tests/fixture-builder'
import { blankXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { DocumentDriverRegistry } from '../src/document-driver'
import { DocumentRegistry } from '../src/document-registry'
import { WorkingCopyCoordinator } from '../src/working-copy-coordinator'
import type { EditorRegisterFrame } from '@nexusdesk/protocol'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function request(sessionId: string): WorkbookSaveRequest {
  return {
    sessionId,
    mode: 'save',
    restoreWriteBack: true,
    edits: [],
    structuralOps: [],
    chartEdits: [],
    visualEdits: [],
    visualAdditions: [],
    tableAdditions: [],
    pivotAdditions: [],
    sheetOps: [],
    sheetOrder: [],
    filterStates: [],
    hyperlinkEdits: [],
    cfStates: [],
    dvStates: [],
    pageSetupStates: [],
    noteStates: [],
    formulaValues: [],
    pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [],
    sheetProtections: [],
    sparklineAdditions: [],
    definedNamesState: null,
    themeState: null,
    workbookProtectionState: null,
    protectedRangeStates: [],
  }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'sheets-working-copy-test-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'source.xlsx')
  const zip = await JSZip.loadAsync(await buildEditFixture())
  for (const [name, entry] of Object.entries(zip.files))
    if (name.endsWith('.xml')) zip.file(name, (await entry.async('text')).replace(/>\s+</g, '><'))
  zip.file(
    'xl/styles.xml',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  )
  const original = await zip.generateAsync({ type: 'nodebuffer' })
  await writeFile(path, original)
  const service = await createSheetsDocumentService(root, path, {
    workingCopyRoot: join(dir, 'store'),
  })
  cleanups.push(() => service.close())
  const driver = service.drivers[0]!
  const bootstrap = (await driver.bootstrap('http://localhost')) as { workbook: WorkbookFile }
  const source = await driver.workingCopy!.acquireSource(bootstrap.workbook.sessionId)
  await driver.workingCopy!.activateSource!(source.sourceContentId, bootstrap.workbook.sessionId)
  return { dir, path, original, service, driver, bootstrap }
}
async function parts(value: WorkbookSaveRequest) {
  return new Map(
    await Promise.all(
      [...encodeWorkbookSaveRequest(value).parts].map(
        async ([id, blob]) => [id, new Uint8Array(await blob.arrayBuffer())] as const,
      ),
    ),
  )
}
async function commit(
  port: NonNullable<Awaited<ReturnType<typeof fixture>>['driver']['workingCopy']>,
  bytes: Uint8Array,
  operationId: string,
) {
  const status = await port.store.getStatus()
  return port.store.commitCheckpoint({
    documentEpoch: status.documentEpoch,
    expectedSavedRevision: status.savedRevision,
    expectedWorkingRevision: status.workingRevision,
    operationId,
    requestFingerprint: operationId,
    planHash: operationId,
    payloadHash: createHash('sha256').update(bytes).digest('hex'),
    payloadByteLength: bytes.length,
    bytes,
    result: { ok: true, summary: operationId, warnings: [] },
  })
}

describe('production Sheets durable native service', () => {
  it('keeps owner A readable and materializable when a second page only bootstraps', async () => {
    const { driver, bootstrap, dir } = await fixture()
    const port = driver.workingCopy!
    const coordinator = new WorkingCopyCoordinator({
      drivers: new DocumentDriverRegistry([driver]),
      documents: new DocumentRegistry([driver.document]),
      uploadRoot: join(dir, 'uploads'),
    })
    const source = await coordinator.bootstrap(
      driver.document.documentId,
      'http://localhost',
      'http',
      bootstrap.workbook.sessionId,
    )
    const registration = {
      type: 'editor:register',
      protocolVersion: 1,
      id: 'register',
      clientId: 'A',
      rendererInstanceId: 'renderer-A',
      documentId: driver.document.documentId,
      editorType: 'sheets',
      revision: source.workingRevision,
      documentEpoch: source.documentEpoch,
      sourceContentId: source.sourceContentId,
      restoredCheckpointId: source.checkpointId,
      editorSessionId: bootstrap.workbook.sessionId,
    } as EditorRegisterFrame
    await coordinator.register(registration, 'http')
    const b = (await driver.bootstrap('http://localhost')) as { workbook: WorkbookFile }
    await expect(
      port.materialize({
        sourceContentId: source.sourceContentId,
        payloadKind: 'xlsx-save-plan',
        parts: await parts(request(b.workbook.sessionId)),
      }),
    ).rejects.toThrow(/registered owner/)
    await coordinator.bootstrap(
      driver.document.documentId,
      'http://localhost',
      'http',
      b.workbook.sessionId,
    )
    await expect(
      coordinator.register(
        {
          ...registration,
          clientId: 'B' as never,
          rendererInstanceId: 'renderer-B' as never,
          editorSessionId: b.workbook.sessionId,
        },
        'http',
      ),
    ).rejects.toMatchObject({ code: 'WRONG_CLIENT' })
    await expect(
      driver.execute('read-workbook-range', { sessionId: b.workbook.sessionId }),
    ).rejects.toThrow(/session/)
    await expect(
      driver.execute('read-workbook-range', {
        sessionId: bootstrap.workbook.sessionId,
        sheetId: 'sheet-1',
        range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
      }),
    ).resolves.toHaveProperty('cells')
    await expect(
      driver.execute('recalculate-workbook', {
        sessionId: bootstrap.workbook.sessionId,
        edits: [],
        reads: [
          { sheetId: 'sheet-1', range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 } },
        ],
      }),
    ).resolves.toHaveProperty('cells')
    await expect(
      port.materialize({
        sourceContentId: source.sourceContentId,
        payloadKind: 'xlsx-save-plan',
        parts: await parts(request(bootstrap.workbook.sessionId)),
      }),
    ).resolves.toBeInstanceOf(Uint8Array)
  })

  it('binds source leases to the exact candidate and keeps owner A after activation TOCTOU failure', async () => {
    const { driver, bootstrap, original } = await fixture()
    const port = driver.workingCopy!
    const source = await port.acquireSource(bootstrap.workbook.sessionId)
    await port.activateSource!(source.sourceContentId, bootstrap.workbook.sessionId)
    const b = (await driver.bootstrap('http://localhost')) as { workbook: WorkbookFile }
    await port.acquireSource(b.workbook.sessionId)
    await commit(port, original, 'moved-after-lease')
    await expect(
      port.activateSource!(source.sourceContentId, b.workbook.sessionId),
    ).rejects.toThrow(/changed/)
    await expect(
      driver.execute('read-workbook-range', { sessionId: b.workbook.sessionId }),
    ).rejects.toThrow(/session/)
    await expect(
      driver.execute('read-workbook-range', {
        sessionId: bootstrap.workbook.sessionId,
        sheetId: 'sheet-1',
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
      }),
    ).resolves.toHaveProperty('cells')
    const c = (await driver.bootstrap('http://localhost')) as { workbook: WorkbookFile }
    await expect(port.acquireSource(b.workbook.sessionId)).rejects.toThrow(/session/)
    await port.acquireSource(c.workbook.sessionId)
    await port.activateSource!(c.workbook.sha256, c.workbook.sessionId)
    await expect(
      driver.execute('read-workbook-range', { sessionId: bootstrap.workbook.sessionId }),
    ).rejects.toThrow(/session/)
  })

  it('opens a startup XLSX and returns a browser bootstrap backed by the real sidecar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexusdesk-document-service-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'Forecast.xlsx')
    await writeFile(path, await blankXlsxBuffer('Summary'))
    const service = await createSheetsDocumentService(root, path, {
      workingCopyRoot: join(directory, 'store'),
    })
    cleanups.push(() => service.close())
    expect(service.drivers.map((driver) => driver.document)).toEqual([
      expect.objectContaining({ title: 'Forecast.xlsx', editorType: 'sheets', path }),
    ])
    await expect(service.drivers[0]!.bootstrap('http://127.0.0.1:43123')).resolves.toMatchObject({
      title: 'Forecast.xlsx',
      websocketUrl: 'ws://127.0.0.1:43123/ws',
      workbook: expect.objectContaining({ path, readOnly: false }),
    })
  })

  it('materializes more than 2 MB and the inline edit cap from binary parts', async () => {
    const { driver, bootstrap } = await fixture()
    const port = driver.workingCopy!
    const source = await port.acquireSource()
    const value = request(bootstrap.workbook.sessionId)
    value.edits = Array.from({ length: 21_001 }, (_, row) => ({
      sheetId: 'sheet-1',
      row,
      column: 0,
      writeValue: true,
      value: '中文😀'.repeat(12),
    }))
    const input = await parts(value)
    expect([...input.values()].reduce((sum, bytes) => sum + bytes.length, 0)).toBeGreaterThan(
      2_000_000,
    )
    const bytes = await port.materialize({
      sourceContentId: source.sourceContentId,
      payloadKind: 'xlsx-save-plan',
      parts: input,
    })
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('text')
    expect(xml).toContain('r="A21001"')
    expect(xml).toContain('中文😀')
    await commit(port, bytes, 'large')
    expect((await port.store.getStatus()).dirty).toBe(true)
  })

  it('materializes cumulative A+B from fixed S exactly once and leaves source/session untouched', async () => {
    const { driver, bootstrap, path, original } = await fixture()
    expect(driver.workingCopy).toBeDefined()
    const port = driver.workingCopy!
    const source = await port.acquireSource()
    const a = request(bootstrap.workbook.sessionId)
    a.structuralOps = [{ sheetId: 'sheet-1', kind: 'insert-rows', index: 0, count: 1 }]
    a.visualAdditions = [
      {
        sheetId: 'sheet-1',
        anchor: {
          fromRow: 0,
          fromColumn: 4,
          fromRowOffset: 0,
          fromColumnOffset: 0,
          toRow: 8,
          toColumn: 12,
          toRowOffset: 0,
          toColumnOffset: 0,
        },
        chart: {
          chartType: 'bar',
          title: 'Only once',
          series: [{ name: 'A', values: [1, 2], categories: ['a', 'b'] }],
        },
      },
    ]
    const first = await port.materialize({
      sourceContentId: source.sourceContentId,
      payloadKind: 'xlsx-save-plan',
      parts: await parts(a),
    })
    await commit(port, first, 'a')
    const b = {
      ...a,
      edits: [{ sheetId: 'sheet-1', row: 6, column: 0, writeValue: true, value: 'B' }],
    }
    const second = await port.materialize({
      sourceContentId: source.sourceContentId,
      payloadKind: 'xlsx-save-plan',
      parts: await parts(b),
    })
    await commit(port, second, 'b')
    const zip = await JSZip.loadAsync(second)
    expect(await zip.file('xl/worksheets/sheet1.xml')!.async('text')).toContain('r="A2"')
    const chartParts = Object.keys(zip.files).filter((name) =>
      /^xl\/charts\/chart\d+\.xml$/.test(name),
    )
    expect(chartParts).toHaveLength(2) // fixture has one orphan chart; exactly one new chart
    expect(await readFile(path)).toEqual(original)
    const range = await driver.execute('read-workbook-range', {
      sessionId: bootstrap.workbook.sessionId,
      sheetId: 'sheet-1',
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    })
    expect(JSON.stringify(range)).toContain('Hello')
  })

  it('publishes neither structural phase nor original when held table phase fails', async () => {
    const { driver, bootstrap, path, original } = await fixture()
    expect(driver.workingCopy).toBeDefined()
    const port = driver.workingCopy!
    const source = await port.acquireSource()
    const value = request(bootstrap.workbook.sessionId)
    value.structuralOps = [{ sheetId: 'sheet-1', kind: 'insert-rows', index: 0, count: 1 }]
    value.tableAdditions = [
      {
        sheetId: 'sheet-1',
        name: 'Same',
        area: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 },
        columnNames: ['A'],
        bandedRows: true,
      },
      {
        sheetId: 'sheet-1',
        name: 'Same',
        area: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 },
        columnNames: ['A'],
        bandedRows: true,
      },
    ]
    await expect(
      port.materialize({
        sourceContentId: source.sourceContentId,
        payloadKind: 'xlsx-save-plan',
        parts: await parts(value),
      }),
    ).rejects.toThrow()
    expect((await port.store.getStatus()).head).toBeNull()
    expect(await readFile(path)).toEqual(original)
  })

  it('restores native reads/recalc from checkpoint, rejects old sessions and promotes empty-journal bytes', async () => {
    const { driver, bootstrap, service, dir, path } = await fixture()
    expect(driver.workingCopy).toBeDefined()
    const port = driver.workingCopy!
    const source = await port.acquireSource()
    const value = request(bootstrap.workbook.sessionId)
    value.edits = [{ sheetId: 'sheet-1', row: 0, column: 2, writeValue: true, value: 17 }]
    const bytes = await port.materialize({
      sourceContentId: source.sourceContentId,
      payloadKind: 'xlsx-save-plan',
      parts: await parts(value),
    })
    await commit(port, bytes, 'edited')
    await service.close()
    const restored = await createSheetsDocumentService(root, path, {
      workingCopyRoot: join(dir, 'store'),
    })
    cleanups.push(() => restored.close())
    const recovered = restored.drivers[0]!
    const state = (await recovered.bootstrap('http://localhost')) as { workbook: WorkbookFile }
    expect(state.workbook.restoredFromRecovery).toBe(true)
    expect(state.workbook.sessionId).not.toBe(bootstrap.workbook.sessionId)
    await expect(
      recovered.execute('read-workbook-formulas', {
        sessionId: bootstrap.workbook.sessionId,
        sheetId: 'sheet-1',
      }),
    ).rejects.toThrow(/session/i)
    const recalc = await recovered.execute('recalculate-workbook', {
      sessionId: state.workbook.sessionId,
      edits: [],
      reads: [
        { sheetId: 'sheet-1', range: { startRow: 2, endRow: 2, startColumn: 1, endColumn: 1 } },
      ],
    })
    expect(JSON.stringify(recalc)).toContain('17')
    await vi.waitFor(async () => {
      const formulas = await recovered.execute('read-workbook-formulas', {
        sessionId: state.workbook.sessionId,
        sheetId: 'sheet-1',
      })
      expect(JSON.stringify(formulas)).toContain('SUM(C1:C2)')
    })
    const status = await recovered.workingCopy!.store.getStatus()
    await recovered.workingCopy!.store.promoteWorkingCopy({
      documentEpoch: status.documentEpoch,
      expectedWorkingRevision: status.workingRevision,
      expectedSavedRevision: status.savedRevision,
      checkpointId: status.head!.checkpointId,
      operationId: 'save',
      requestFingerprint: 'save',
      planHash: 'save',
      result: { ok: true, summary: 'saved', warnings: [] },
    })
    expect(await readFile(path)).toEqual(Buffer.from(bytes))
    const rebased = (await recovered.bootstrap('http://localhost')) as { workbook: WorkbookFile }
    expect(rebased.workbook.restoredFromRecovery).toBe(false)
    expect(rebased.workbook.sessionId).not.toBe(state.workbook.sessionId)
  })

  it('rejects hydration when head changes between native bootstrap and source lease', async () => {
    const { driver, bootstrap } = await fixture()
    expect(driver.workingCopy).toBeDefined()
    const port = driver.workingCopy!
    await commit(port, await buildEditFixture(), 'raced')
    await expect(port.acquireSource(bootstrap.workbook.sessionId)).rejects.toThrow(
      /stale|changed|hydrate/i,
    )
  })

  it('writes metadata, formula caches and held table/pivot/names before publishing one complete XLSX', async () => {
    const { driver, bootstrap, path, original } = await fixture()
    const port = driver.workingCopy!
    const source = await port.acquireSource()
    const value = request(bootstrap.workbook.sessionId)
    const area = { startRow: 1, endRow: 3, startColumn: 0, endColumn: 2 }
    value.structuralOps = [{ sheetId: 'sheet-1', kind: 'insert-rows', index: 0, count: 1 }]
    value.edits = [
      { sheetId: 'sheet-1', row: 1, column: 2, writeValue: true, value: 17 },
      { sheetId: 'sheet-1', row: 3, column: 1, writeValue: true, value: null, formula: '=C2*2' },
    ]
    value.formulaValues = [{ sheetId: 'sheet-1', row: 3, column: 1, value: 34 }]
    value.bulkConstantFills = [
      { sheetId: 'sheet-1', startRow: 8, endRow: 9, startColumn: 0, endColumn: 0, value: 9 },
    ]
    value.filterStates = [
      {
        sheetId: 'sheet-1',
        filter: { range: area, columns: [] },
        hiddenRows: [2],
        visibilityRange: area,
      },
    ]
    value.cfStates = [
      {
        sheetId: 'sheet-1',
        rules: [
          {
            ranges: [area],
            stopIfTrue: false,
            rule: {
              type: 'highlightCell',
              subType: 'number',
              operator: 'greaterThan',
              value: 5,
              style: { bg: { rgb: '#FFF2CC' } },
            },
          },
        ],
      },
    ]
    value.dvStates = [
      {
        sheetId: 'sheet-1',
        rules: [
          {
            ranges: [area],
            rule: { type: 'decimal', operator: 'greaterThan', formula1: '3', allowBlank: true },
          },
        ],
      },
    ]
    value.hyperlinkEdits = [
      { sheetId: 'sheet-1', row: 1, column: 0, target: 'https://example.com' },
    ]
    value.pageSetupStates = [{ sheetId: 'sheet-1', orientation: 'landscape', paperSize: 9 }]
    value.noteStates = [
      {
        sheetId: 'sheet-1',
        notes: [{ row: 1, column: 0, author: 'Tester', text: 'Durable note' }],
      },
    ]
    value.sheetProtections = [{ sheetId: 'sheet-1', protected: true }]
    value.protectedRangeStates = [
      { sheetId: 'sheet-1', ranges: [{ name: 'Editable', sqref: 'A2' }] },
    ]
    value.workbookProtectionState = { lockStructure: true }
    value.definedNamesState = {
      names: [{ name: 'DurableName', formula: 'Data!$C$2' }],
      preserveNames: [],
    }
    value.sparklineAdditions = [
      { sheetId: 'sheet-1', type: 'line', cells: [{ cell: 'D2', sourceRef: 'Data!A2:C2' }] },
    ]
    value.tableAdditions = [
      {
        sheetId: 'sheet-1',
        area: { startRow: 6, endRow: 7, startColumn: 0, endColumn: 0 },
        name: 'DurableTable',
        columnNames: ['Amount'],
        bandedRows: true,
      },
    ]
    value.pivotAdditions = [
      {
        sheetId: 'sheet-1',
        sourceSheetId: 'sheet-1',
        sourceArea: area,
        location: { startRow: 0, endRow: 4, startColumn: 5, endColumn: 6 },
        name: 'DurablePivot',
        fieldNames: ['Region', 'Product', 'Amount'],
        rowFieldIndices: [0],
        rowItems: ['East', 'South', 'North'],
        values: [{ fieldIndex: 2, agg: 'sum' }],
      },
    ]
    value.visualAdditions = [
      {
        sheetId: 'sheet-1',
        anchor: {
          fromRow: 10,
          fromColumn: 3,
          fromRowOffset: 0,
          fromColumnOffset: 0,
          toRow: 12,
          toColumn: 5,
          toRowOffset: 0,
          toColumnOffset: 0,
        },
        image: {
          mediaType: 'image/png',
          base64:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1cAAAAASUVORK5CYII=',
        },
      },
    ]
    const bytes = await port.materialize({
      sourceContentId: source.sourceContentId,
      payloadKind: 'xlsx-save-plan',
      parts: await parts(value),
    })
    expect((await port.store.getStatus()).head).toBeNull()
    await commit(port, bytes, 'full')
    expect((await port.store.getStatus()).workingRevision).toBe(2)
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('text')
    for (const content of [
      '<f>C2*2</f><v>34</v>',
      '<autoFilter',
      '<conditionalFormatting',
      '<dataValidation',
      'orientation="landscape"',
      '<sheetProtection',
      'name="Editable"',
      'sparkline',
      '<hyperlink',
      '<v>9</v>',
    ])
      expect(xml).toContain(content)
    const workbook = await zip.file('xl/workbook.xml')!.async('text')
    expect(workbook).toContain('DurableName')
    expect(workbook).toContain('lockStructure="1"')
    expect(await zip.file('xl/tables/table1.xml')!.async('text')).toContain('DurableTable')
    expect(await zip.file('xl/pivotTables/pivotTable1.xml')!.async('text')).toContain(
      'DurablePivot',
    )
    expect(await zip.file('xl/comments1.xml')!.async('text')).toContain('Durable note')
    expect(await readFile(path)).toEqual(original)
    const restored = (await driver.bootstrap('http://localhost')) as { workbook: WorkbookFile }
    const image = restored.workbook.visuals.find((visual) => visual.kind === 'image')!
    const media = await driver.execute('read-workbook-media', {
      sessionId: restored.workbook.sessionId,
      visualId: image.id,
    })
    expect(media).toMatchObject({
      mediaType: 'image/png',
      base64: value.visualAdditions[0]!.image!.base64,
    })
    const pivot = await driver.execute('read-pivot-definition', {
      sessionId: restored.workbook.sessionId,
      path: 'xl/pivotTables/pivotTable1.xml',
      cachePath: 'xl/pivotCache/pivotCacheDefinition1.xml',
    })
    expect(JSON.stringify(pivot)).toContain('Region')
  })

  it('persists sheet add/rename/order using source ids and preserves the original file', async () => {
    const { driver, bootstrap } = await fixture()
    const port = driver.workingCopy!
    const source = await port.acquireSource()
    const value = request(bootstrap.workbook.sessionId)
    value.sheetOps = [
      { kind: 'rename-sheet', sheetId: 'sheet-1', newName: 'Renamed' },
      { kind: 'add-sheet', sheetId: 'new', name: 'Added' },
    ]
    value.sheetOrder = ['new', 'sheet-1']
    value.edits = [
      { sheetId: 'new', row: 0, column: 0, writeValue: true, value: 'New sheet value' },
    ]
    const bytes = await port.materialize({
      sourceContentId: source.sourceContentId,
      payloadKind: 'xlsx-save-plan',
      parts: await parts(value),
    })
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('xl/workbook.xml')!.async('text')
    expect(xml.indexOf('name="Added"')).toBeLessThan(xml.indexOf('name="Renamed"'))
    expect(await zip.file('xl/worksheets/sheet2.xml')!.async('text')).toContain('New sheet value')
  })
})
