import { describe, expect, it } from 'vitest'
import { buildWorkbookSavePlan } from '../src/shared/workbook-save-plan'
import type { WorkbookSaveRequest } from '../src/shared/desktop-api'

function emptySaveRequest(): WorkbookSaveRequest {
  return {
    sessionId: '5d4f6f7a-1c2b-4e3d-9a8f-0b1c2d3e4f5a',
    mode: 'save',
    restoreWriteBack: true,
    edits: [],
    bulkConstantFills: [],
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

describe('complete workbook save mapping', () => {
  it('resolves source names, added sheets and final renamed tab order without changing cell coordinates', () => {
    const request = emptySaveRequest()
    request.edits = [
      { sheetId: 's1', row: 2, column: 1, writeValue: true, value: null, formula: '=2+2' },
    ]
    request.formulaValues = [{ sheetId: 's1', row: 2, column: 1, value: 4 }]
    request.sheetOps = [
      { kind: 'rename-sheet', sheetId: 's1', newName: 'Renamed' },
      { kind: 'add-sheet', sheetId: 'new', name: 'Added' },
    ]
    request.sheetOrder = ['new', 's1']
    request.structuralOps = [{ sheetId: 's1', kind: 'insert-rows', index: 0, count: 1 }]
    const plan = buildWorkbookSavePlan(request, new Map([['s1', 'Data']]))
    expect(plan.edits).toMatchObject([
      { sheetName: 'Data', row: 2, column: 1, cell: { formula: '=2+2' } },
    ])
    expect(plan.formulaValues).toEqual([
      { sheetName: 'Data', cells: [{ row: 2, column: 1, value: 4 }] },
    ])
    expect(plan.structuralOps).toEqual([
      { sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] },
    ])
    expect(plan.sheetPlan).toMatchObject({
      order: ['Added', 'Renamed'],
      renames: [{ sheetName: 'Data', newName: 'Renamed' }],
    })
  })

  it('maps every supported metadata field instead of silently dropping save state', () => {
    const request = emptySaveRequest()
    request.bulkConstantFills = [
      { sheetId: 's1', startRow: 1, endRow: 3, startColumn: 0, endColumn: 0, value: 7 },
    ]
    request.filterStates = [
      {
        sheetId: 's1',
        filter: null,
        hiddenRows: [],
        visibilityRange: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 },
      },
    ]
    request.hyperlinkEdits = [{ sheetId: 's1', row: 0, column: 0, target: 'https://example.com' }]
    request.cfStates = [{ sheetId: 's1', rules: [] }]
    request.dvStates = [{ sheetId: 's1', rules: [] }]
    request.noteStates = [{ sheetId: 's1', notes: [] }]
    request.sheetProtections = [{ sheetId: 's1', protected: true }]
    request.protectedRangeStates = [{ sheetId: 's1', ranges: [{ name: 'Inputs', sqref: 'A1' }] }]
    request.sparklineAdditions = [
      { sheetId: 's1', type: 'line', cells: [{ cell: 'D1', sourceRef: 'Data!A1:C1' }] },
    ]
    request.definedNamesState = {
      names: [{ name: 'Score', formula: 'Data!$A$1' }],
      preserveNames: [],
    }
    request.themeState = { fonts: { name: 'Office', major: 'Arial', minor: 'Arial' } }
    request.workbookProtectionState = { lockStructure: true }
    request.pivotCacheRefreshPaths = ['xl/pivotCache/pivotCacheDefinition1.xml']
    request.pivotRefreshUpdates = [
      {
        cachePath: 'xl/pivotCache/pivotCacheDefinition1.xml',
        sheetId: 's1',
        newOutputRef: 'A1:B3',
      },
    ]
    const plan = buildWorkbookSavePlan(request, new Map([['s1', 'Data']]))
    expect(plan).toMatchObject({
      bulkConstantFills: [{ sheetName: 'Data', value: 7 }],
      filterStates: [{ sheetName: 'Data', filter: null }],
      hyperlinkEdits: [{ sheetName: 'Data', edits: [{ target: 'https://example.com' }] }],
      cfStates: [{ sheetName: 'Data', rules: [] }],
      dvStates: [{ sheetName: 'Data', rules: [] }],
      noteStates: [{ sheetName: 'Data', notes: [] }],
      sheetProtections: [{ sheetName: 'Data', protected: true }],
      protectedRangeStates: [{ sheetName: 'Data', ranges: [{ name: 'Inputs', sqref: 'A1' }] }],
      sparklineAdditions: [{ sheetName: 'Data', cells: [{ cell: 'D1', sourceRef: 'Data!A1:C1' }] }],
      definedNamesState: { names: [{ name: 'Score', formula: 'Data!$A$1' }] },
      themeState: { fonts: { major: 'Arial' } },
      workbookProtectionState: { lockStructure: true },
      pivotCacheRefreshPaths: ['xl/pivotCache/pivotCacheDefinition1.xml'],
      pivotRefreshUpdates: [{ sheetName: 'Data', newOutputRef: 'A1:B3' }],
    })
    expect(() => buildWorkbookSavePlan(request, new Map())).toThrow('Unknown worksheet')
  })
})
