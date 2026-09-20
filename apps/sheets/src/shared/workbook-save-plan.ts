import type { CellEdit, SheetStructuralOps } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import type { SheetEditPlan } from '@genoffice/xlsx-gateway/gateway/xlsx-sheets'
import type { StreamingSaveRequest } from '@genoffice/xlsx-gateway/gateway/xlsx-package-io'
import { workbookSaveRequestSchema, type WorkbookSaveRequest } from './desktop-api'

/** Binary checkpoint transport; limits are bytes, independently of Electron's IPC item cap. */
const PART_LIMIT = 256 * 1024
const TOTAL_LIMIT = 128 * 1024 * 1024
type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue }
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeWorkbookSaveRequest(
  request: WorkbookSaveRequest,
): import('@nexusdesk/web-client').BrowserWorkingCopyPayload {
  const parts = new Map<string, Blob>()
  let total = 0
  const put = (id: string, bytes: Uint8Array): string => {
    total += bytes.byteLength
    if (total > TOTAL_LIMIT) throw new Error('Workbook checkpoint exceeds 128 MiB.')
    parts.set(id, new Blob([bytes as Uint8Array<ArrayBuffer>]))
    return id
  }
  let serial = 0
  const pack = (value: unknown, key = ''): WireValue => {
    if (key === 'base64' && typeof value === 'string') {
      const binary = atob(value)
      return {
        $asset: put(
          'asset-' + String(serial++).padStart(4, '0'),
          Uint8Array.from(binary, (c) => c.charCodeAt(0)),
        ),
      }
    }
    if (Array.isArray(value)) {
      const ids: string[] = []
      let entries: string[] = []
      let size = 2
      const flush = () => {
        if (entries.length === 0) return
        ids.push(
          put(
            'edits-' + String(serial++).padStart(4, '0'),
            encoder.encode('[' + entries.join(',') + ']'),
          ),
        )
        entries = []
        size = 2
      }
      for (const item of value) {
        // Nested growing lists (notes, rules, names, pivot members) have the same
        // byte boundary. Scalar records remain indivisible, and images stay binary.
        const raw = JSON.stringify(pack(item))
        const bytes = encoder.encode(raw).byteLength
        if (bytes + 2 > PART_LIMIT) throw new Error('One workbook record exceeds 256 KiB.')
        if (size + bytes + (entries.length ? 1 : 0) > PART_LIMIT) flush()
        size += bytes + (entries.length ? 1 : 0)
        entries.push(raw)
      }
      flush()
      return { $parts: ids }
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, pack(v, k)]),
      )
    }
    return value as WireValue
  }
  const manifest = encoder.encode(JSON.stringify({ schemaVersion: 1, request: pack(request) }))
  if (manifest.byteLength > PART_LIMIT) throw new Error('Workbook manifest exceeds 256 KiB.')
  put('manifest', manifest)
  return { kind: 'xlsx-save-plan', parts }
}

export function decodeWorkbookSaveRequest(
  parts: ReadonlyMap<string, Uint8Array>,
): WorkbookSaveRequest {
  const used = new Set(['manifest'])
  const json = (id: string): unknown => {
    const bytes = parts.get(id)
    if (!bytes || bytes.byteLength > PART_LIMIT)
      throw new Error('Missing or oversized workbook JSON part.')
    return JSON.parse(decoder.decode(bytes))
  }
  const unpack = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(unpack)
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      if ('$parts' in obj) {
        if (Object.keys(obj).length !== 1 || !Array.isArray(obj.$parts))
          throw new Error('Invalid workbook parts reference.')
        return obj.$parts.flatMap((id) => {
          if (typeof id !== 'string' || !/^edits-\d+$/.test(id) || used.has(id))
            throw new Error('Invalid or repeated workbook part.')
          used.add(id)
          const items = json(id)
          if (!Array.isArray(items)) throw new Error('Workbook list part must be an array.')
          return items.map(unpack)
        })
      }
      if ('$asset' in obj) {
        const id = obj.$asset
        if (
          Object.keys(obj).length !== 1 ||
          typeof id !== 'string' ||
          !/^asset-\d+$/.test(id) ||
          used.has(id)
        )
          throw new Error('Invalid workbook asset.')
        used.add(id)
        const bytes = parts.get(id)
        if (!bytes) throw new Error('Missing workbook asset.')
        let binary = ''
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
        return btoa(binary)
      }
      return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, unpack(item)]))
    }
    return value
  }
  let total = 0
  for (const bytes of parts.values()) total += bytes.byteLength
  if (total > TOTAL_LIMIT) throw new Error('Workbook checkpoint exceeds 128 MiB.')
  const manifest = json('manifest') as { schemaVersion?: number; request?: unknown }
  if (manifest.schemaVersion !== 1) throw new Error('Invalid workbook manifest version.')
  const raw = unpack(manifest.request) as WorkbookSaveRequest
  if (used.size !== parts.size) throw new Error('Unreferenced workbook checkpoint parts.')
  if (
    raw.targetPath !== undefined ||
    raw.csvContent !== undefined ||
    raw.editsTransferId !== undefined ||
    raw.mode !== 'save'
  )
    throw new Error('Unsupported Web workbook save mode.')
  // The binary transport has its own total-byte limit. Retain all record schemas while
  // removing only the Electron inline item-count caps for edits and formula caches.
  const parsed = workbookSaveRequestSchema.parse({
    ...raw,
    restoreWriteBack: true,
    edits: [],
    formulaValues: [],
  })
  return {
    ...parsed,
    edits: raw.edits.map((edit) => workbookSaveRequestSchema.shape.edits.element.parse(edit)),
    formulaValues: raw.formulaValues.map((cell) =>
      workbookSaveRequestSchema.shape.formulaValues.element.parse(cell),
    ),
  }
}

/** Pure Electron/Web mapping from renderer sheet IDs to immutable source sheet names. */
export function buildWorkbookSavePlan(
  request: WorkbookSaveRequest,
  sheetNames: ReadonlyMap<string, string>,
): Omit<StreamingSaveRequest, 'client' | 'sourcePath' | 'targetPath'> {
  // Sheet ops resolve first: added sheets have Univer ids the session map
  // doesn't know, so cell edits into them resolve through the op's name.
  const addedSheetNames = new Map<string, string>()
  // Added sheet id → file name of the sheet whose part seeds the new part.
  const duplicateSources = new Map<string, string>()
  const renames: { sheetName: string; newName: string }[] = []
  const removals: string[] = []
  const hiddenChanges: { sheetName: string; hidden: boolean }[] = []
  let orderChanged = false
  for (const op of request.sheetOps) {
    if (op.kind === 'add-sheet') {
      addedSheetNames.set(op.sheetId, op.name)
      continue
    }
    if (op.kind === 'duplicate-sheet') {
      // The renderer resolves duplicate chains to a sheet the file knows,
      // so the source must be in the session map.
      const sourceName = sheetNames.get(op.sourceSheetId)
      if (!sourceName) throw new Error(`Unknown duplicate source ${op.sourceSheetId}.`)
      addedSheetNames.set(op.sheetId, op.name)
      duplicateSources.set(op.sheetId, sourceName)
      continue
    }
    if (op.kind === 'reorder-sheets') {
      orderChanged = true
      continue
    }
    const sheetName = addedSheetNames.get(op.sheetId) ?? sheetNames.get(op.sheetId)
    if (!sheetName) throw new Error(`Unknown worksheet ${op.sheetId}.`)
    if (op.kind === 'rename-sheet') renames.push({ sheetName, newName: op.newName })
    else if (op.kind === 'set-sheet-hidden') {
      hiddenChanges.push({ sheetName, hidden: op.hidden })
    } else removals.push(sheetName)
  }
  const renameByOriginal = new Map(renames.map((rename) => [rename.sheetName, rename.newName]))
  const resolveSheetName = (sheetId: string): string => {
    const sheetName = addedSheetNames.get(sheetId) ?? sheetNames.get(sheetId)
    if (!sheetName) throw new Error(`Unknown worksheet ${sheetId}.`)
    return sheetName
  }
  let sheetPlan: SheetEditPlan | undefined
  if (request.sheetOps.length > 0) {
    sheetPlan = {
      renames,
      additions: [...addedSheetNames].map(([sheetId, name]) => ({
        name,
        sourceSheetName: duplicateSources.get(sheetId),
      })),
      removals,
      hiddenChanges,
      orderChanged,
      order: request.sheetOrder.map((sheetId) => {
        const original = resolveSheetName(sheetId)
        return addedSheetNames.has(sheetId)
          ? original
          : (renameByOriginal.get(original) ?? original)
      }),
    }
  }

  const edits: CellEdit[] = request.edits.map((edit) => ({
    sheetName: resolveSheetName(edit.sheetId),
    row: edit.row,
    column: edit.column,
    writeValue: edit.writeValue,
    cell: { value: edit.value, formula: edit.formula },
    style: edit.style,
    rich: edit.rich,
    styleReset: edit.styleReset,
  }))
  const bulkConstantFills = (request.bulkConstantFills ?? []).map(({ sheetId, ...fill }) => ({
    sheetName: resolveSheetName(sheetId),
    ...fill,
  }))
  const opsBySheet = new Map<string, SheetStructuralOps['ops'][number][]>()
  for (const op of request.structuralOps) {
    const sheetName = resolveSheetName(op.sheetId)
    const sheetOps = opsBySheet.get(sheetName) ?? []
    if ('range' in op) {
      sheetOps.push({ kind: op.kind, range: op.range })
    } else if ('size' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, size: op.size })
    } else if ('level' in op) {
      sheetOps.push({
        kind: op.kind,
        start: op.start,
        end: op.end,
        level: op.level,
        ...(op.collapsed === undefined ? {} : { collapsed: op.collapsed }),
      })
    } else if ('hidden' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, hidden: op.hidden })
    } else if ('style' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, style: op.style })
    } else if ('before' in op) {
      sheetOps.push({ kind: op.kind, index: op.index, count: op.count, before: op.before })
    } else {
      sheetOps.push({ kind: op.kind, index: op.index, count: op.count })
    }
    opsBySheet.set(sheetName, sheetOps)
  }
  const structuralOps: SheetStructuralOps[] = [...opsBySheet].map(([sheetName, ops]) => ({
    sheetName,
    ops,
  }))
  const filterStates = request.filterStates.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    filter: state.filter,
    hiddenRows: state.hiddenRows,
    visibilityRange: state.visibilityRange,
  }))
  const linksBySheet = new Map<string, { row: number; column: number; target: string | null }[]>()
  for (const link of request.hyperlinkEdits) {
    const sheetName = resolveSheetName(link.sheetId)
    const sheetLinks = linksBySheet.get(sheetName) ?? []
    sheetLinks.push({ row: link.row, column: link.column, target: link.target })
    linksBySheet.set(sheetName, sheetLinks)
  }
  const hyperlinkEdits = [...linksBySheet].map(([sheetName, links]) => ({
    sheetName,
    edits: links,
  }))
  const cfStates = request.cfStates.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    rules: state.rules,
  }))
  const dvStates = request.dvStates.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    rules: state.rules,
  }))
  const sheetProtections = request.sheetProtections.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    protected: state.protected,
  }))
  const protectedRangeStates = request.protectedRangeStates.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    ranges: state.ranges,
  }))
  const pageSetupStates = request.pageSetupStates.map(({ sheetId, ...state }) => ({
    sheetName: resolveSheetName(sheetId),
    ...state,
  }))
  const noteStates = request.noteStates.map(({ sheetId, notes }) => ({
    sheetName: resolveSheetName(sheetId),
    notes,
  }))
  const visualAdditions = request.visualAdditions.map((addition) => ({
    sheetName: resolveSheetName(addition.sheetId),
    anchor: addition.anchor,
    chart: addition.chart,
    shape: addition.shape,
    image: addition.image,
  }))
  const tableAdditions = request.tableAdditions.map((table) => ({
    sheetName: resolveSheetName(table.sheetId),
    area: table.area,
    name: table.name,
    columnNames: table.columnNames,
    style: table.style,
    bandedRows: table.bandedRows,
  }))
  const pivotAdditions = request.pivotAdditions.map((pivot) => ({
    sheetName: resolveSheetName(pivot.sheetId),
    sourceSheetName: resolveSheetName(pivot.sourceSheetId),
    sourceArea: pivot.sourceArea,
    location: pivot.location,
    name: pivot.name,
    fieldNames: pivot.fieldNames,
    rowFieldIndices: pivot.rowFieldIndices,
    columnFieldIndex: pivot.columnFieldIndex,
    pageFieldIndices: pivot.pageFieldIndices,
    rowItems: pivot.rowItems,
    rowLevelItems: pivot.rowLevelItems,
    rowLines: pivot.rowLines,
    columnItems: pivot.columnItems,
    columnFieldIndices: pivot.columnFieldIndices,
    colLevelItems: pivot.colLevelItems,
    colLines: pivot.colLines,
    groupings: pivot.groupings,
    filters: pivot.filters,
    rowHiddenItems: pivot.rowHiddenItems,
    colHiddenItems: pivot.colHiddenItems,
    values: pivot.values,
  }))
  const sparklineAdditions = request.sparklineAdditions.map(({ sheetId, ...group }) => ({
    sheetName: resolveSheetName(sheetId),
    ...group,
  }))
  // Recalculated formula values: sheetId → file sheet name, the same
  // resolution the cell edits use.
  const formulaValuesBySheet = new Map<
    string,
    { row: number; column: number; value: string | number | boolean | null | { error: string } }[]
  >()
  for (const cell of request.formulaValues) {
    const sheetName = resolveSheetName(cell.sheetId)
    const list = formulaValuesBySheet.get(sheetName) ?? []
    list.push({ row: cell.row, column: cell.column, value: cell.value })
    formulaValuesBySheet.set(sheetName, list)
  }
  const formulaValues = [...formulaValuesBySheet].map(([sheetName, cells]) => ({
    sheetName,
    cells,
  }))
  return {
    edits,
    bulkConstantFills,
    structuralOps,
    chartEdits: request.chartEdits,
    // Located by package-absolute drawingPath, so no sheet-name mapping.
    visualEdits: request.visualEdits,
    sheetPlan,
    filterStates,
    hyperlinkEdits,
    cfStates,
    dvStates,
    sheetProtections,
    definedNamesState: request.definedNamesState,
    themeState: request.themeState,
    workbookProtectionState: request.workbookProtectionState,
    protectedRangeStates,
    visualAdditions,
    pageSetupStates,
    noteStates,
    tableAdditions,
    pivotAdditions,
    sparklineAdditions,
    formulaValues,
    pivotCacheRefreshPaths: request.pivotCacheRefreshPaths,
    // Output-area expansion from layout growth: sheetId → sheet name; the part
    // path is resolved by the gateway.
    pivotRefreshUpdates: request.pivotRefreshUpdates.map((update) => ({
      cachePath: update.cachePath,
      sheetName: resolveSheetName(update.sheetId),
      newOutputRef: update.newOutputRef,
      ...(update.relayout === undefined
        ? {}
        : {
            relayout: (({ sheetId: _sheetId, sourceSheetId, ...rest }) => ({
              ...rest,
              sourceSheetName: resolveSheetName(sourceSheetId),
            }))(update.relayout),
          }),
    })),
  }
}
