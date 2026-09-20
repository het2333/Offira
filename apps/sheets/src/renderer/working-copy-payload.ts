import type { BrowserWorkingCopyPayload } from '@nexusdesk/web-client'
import type { JsonValue } from '@nexusdesk/protocol'
import { collectWorkbookSaveRequest, type SaveContext } from './save-actions'
import { encodeWorkbookSaveRequest } from '../shared/workbook-save-plan'
export { encodeWorkbookSaveRequest, decodeWorkbookSaveRequest } from '../shared/workbook-save-plan'

export async function buildWorkingCopyPayload(
  ctx: SaveContext,
): Promise<BrowserWorkingCopyPayload> {
  assertWorkingCopyOperationsPersistable(ctx, [])
  return encodeWorkbookSaveRequest(collectWorkbookSaveRequest(ctx))
}

/** The two-stage writer cannot resolve held objects on not-yet-saved sheet IDs. */
export function assertWorkingCopyOperationsPersistable(
  ctx: SaveContext,
  operations: readonly JsonValue[],
): void {
  const journal = ctx.lazyWorkbookRef.current?.editJournal
  if (!journal) throw new Error('The workbook is not ready.')
  const ops = operations.filter(
    (op): op is Record<string, JsonValue> => !!op && typeof op === 'object' && !Array.isArray(op),
  )
  const structural = new Set([
    'insert_rows',
    'delete_rows',
    'insert_cols',
    'delete_cols',
    'set_rows_hidden',
    'set_cols_hidden',
    'merge_cells',
    'unmerge_cells',
    'set_row_height',
    'set_col_width',
  ])
  const hasStructure =
    [...journal.structuralOps.values()].some((list) => list.length > 0) ||
    ops.some((op) => typeof op.op === 'string' && structural.has(op.op))
  const added = (id: unknown) => typeof id === 'string' && journal.sheets.added.has(id)
  const strandedPivot =
    journal.pivotAdds.some((pivot) => added(pivot.sheetId) || added(pivot.sourceSheetId)) ||
    ops.some((op) => op.op === 'add_pivot' && (added(op.sheetId) || added(op.targetSheetId)))
  const strandedTable =
    hasStructure &&
    (journal.tableAdds.some((table) => added(table.sheetId)) ||
      ops.some((op) => op.op === 'add_table' && added(op.sheetId)))
  if (strandedPivot || strandedTable)
    throw new Error(
      'Save and reload newly added sheets before combining their tables or pivots with structural changes.',
    )
}
