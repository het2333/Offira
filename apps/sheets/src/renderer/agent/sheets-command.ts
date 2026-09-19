import type { AgentIssue, AgentReadResult, AgentToolResult, JsonValue } from '@nexusdesk/protocol'
import {
  workbookOperationSchema,
  type WorkbookOperation,
} from '@genoffice/xlsx-gateway/domain/workbook-dsl'
import { z } from 'zod'

import { normalizeSheetRefs, primaryCellOf, primarySheetId, type SheetRef } from '../mcp-sheet-refs'

export interface McpSheetHandlers {
  hasWorkbook: () => boolean
  context: () => unknown
  readCells: (addresses: string[], sheetId?: string) => unknown
  sheets: () => readonly SheetRef[]
  applyOps: (ops: WorkbookOperation[], dryRun: boolean) => Promise<unknown>
  focusSheet: (sheetId: string, address?: string) => void
  saveTo: (
    path: string,
    overwrite: boolean,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
  saveInPlace?: () => Promise<{ ok: boolean; path?: string; error?: string }>
}

export interface SheetsCommand {
  command: string
  arguments: Record<string, unknown>
}

export class SheetsCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SheetsCommandError'
  }
}

function describeOpError(ops: unknown[], error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'invalid ops'
  const index = typeof issue.path[0] === 'number' ? issue.path[0] : -1
  const raw = index >= 0 ? ops[index] : undefined
  const opName =
    raw && typeof raw === 'object' && 'op' in raw ? String((raw as { op: unknown }).op) : 'unknown'
  const field = issue.path.slice(1).join('.')
  const hint = issue.path.includes('sheetId')
    ? ' — call read_sheet first and use a sheetId from its output'
    : ''
  return `op #${index} (${opName}) is invalid${field ? ` (${field})` : ''}: ${issue.message}${hint}`
}

function resolveReadSheet(
  handlers: McpSheetHandlers,
  name: string | undefined,
  id: string | undefined,
): string | undefined {
  if (name === undefined) return id
  const sheets = handlers.sheets()
  if (sheets.some((sheet) => sheet.id === name)) return name
  const match = sheets.find(
    (sheet) => sheet.name.trim().toLowerCase() === name.trim().toLowerCase(),
  )
  if (match) return match.id
  const known = sheets.length === 0 ? 'none' : sheets.map((sheet) => sheet.name).join(', ')
  throw new SheetsCommandError(
    'SHEET_NOT_FOUND',
    `no worksheet named "${name}" in this workbook (sheets: ${known}); call read_sheet for the current sheets`,
  )
}

export function prepareSheetsOperations(
  handlers: McpSheetHandlers,
  input: unknown,
): WorkbookOperation[] {
  const ops = Array.isArray(input) ? input : []
  if (ops.length === 0)
    throw new SheetsCommandError('EMPTY_OPERATIONS', 'ops must be a non-empty array')
  const named = normalizeSheetRefs(ops, handlers.sheets())
  if (!named.ok) throw new SheetsCommandError('INVALID_SHEET_REFERENCE', named.error)
  const parsed = z.array(workbookOperationSchema).safeParse(named.ops)
  if (!parsed.success) {
    throw new SheetsCommandError('INVALID_OPERATION', describeOpError(named.ops, parsed.error))
  }
  return parsed.data
}

export function operationTargets(
  handlers: McpSheetHandlers,
  operations: readonly WorkbookOperation[],
): string[] {
  const sheets = new Map(handlers.sheets().map((sheet) => [sheet.id, sheet.name]))
  return operations.map((operation) => {
    const record = operation as unknown as Record<string, unknown>
    const sheetId = typeof record.sheetId === 'string' ? record.sheetId : undefined
    const sheet = sheetId === undefined ? undefined : (sheets.get(sheetId) ?? sheetId)
    const location = ['address', 'range', 'target', 'name']
      .map((key) => record[key])
      .find((value): value is string => typeof value === 'string')
    if (sheet !== undefined && location !== undefined) return `${sheet}!${location}`
    return sheet ?? location ?? String(record.op ?? 'workbook')
  })
}

function jsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) return null
  return JSON.parse(encoded) as JsonValue
}

function failure(code: string, message: string, target?: string): AgentToolResult {
  const warning: AgentIssue = { code, message, ...(target === undefined ? {} : { target }) }
  return { ok: false, summary: message, warnings: [warning] }
}

function applyFailed(outcome: unknown): string | undefined {
  if (typeof outcome !== 'object' || outcome === null) return undefined
  const record = outcome as { ok?: unknown; reason?: unknown; error?: unknown }
  if (record.ok !== false) return undefined
  if (typeof record.reason === 'string') return record.reason
  if (typeof record.error === 'string') return record.error
  return 'the spreadsheet operation failed'
}

export async function executeSheetsCommand(
  handlers: McpSheetHandlers,
  command: SheetsCommand,
): Promise<AgentReadResult> {
  try {
    const payload = command.arguments
    if (command.command === 'read_sheet') {
      const addresses = Array.isArray(payload.addresses)
        ? payload.addresses.filter((address): address is string => typeof address === 'string')
        : []
      const sheetId = resolveReadSheet(
        handlers,
        typeof payload.sheet === 'string' ? payload.sheet : undefined,
        typeof payload.sheetId === 'string' ? payload.sheetId : undefined,
      )
      const data =
        addresses.length > 0
          ? { cells: handlers.readCells(addresses, sheetId) }
          : { context: handlers.context() }
      return {
        ok: true,
        summary:
          addresses.length > 0
            ? `Read ${String(addresses.length)} spreadsheet target(s).`
            : 'Read the workbook summary.',
        warnings: [],
        data: jsonValue(data),
      }
    }
    if (command.command === 'apply_ops') {
      const operations = prepareSheetsOperations(handlers, payload.ops)
      const sheetId = primarySheetId(operations)
      if (sheetId !== undefined) handlers.focusSheet(sheetId, primaryCellOf(operations))
      const dryRun = payload.dryRun === true
      const outcome = await handlers.applyOps(operations, dryRun)
      const reason = applyFailed(outcome)
      if (reason !== undefined) return failure('APPLY_FAILED', reason)
      const targets = operationTargets(handlers, operations)
      return {
        ok: true,
        summary: dryRun
          ? `Validated ${String(operations.length)} spreadsheet operation(s) without applying them.`
          : `Applied ${String(operations.length)} spreadsheet operation(s).`,
        changes: { targets, count: operations.length },
        warnings: [],
      }
    }
    if (command.command === 'save_sheet') {
      const inPlace = payload.inPlace === true
      if (inPlace) {
        if (handlers.saveInPlace === undefined) {
          return failure('SAVE_UNAVAILABLE', 'this build cannot save the open workbook in place')
        }
        const saved = await handlers.saveInPlace()
        if (!saved.ok)
          return failure('SAVE_FAILED', saved.error ?? 'the spreadsheet could not be saved')
        return {
          ok: true,
          summary: `Saved the open workbook${saved.path === undefined ? '.' : ` to ${saved.path}.`}`,
          warnings: [],
          data: jsonValue(saved),
        }
      }
      const path = typeof payload.path === 'string' ? payload.path : ''
      if (!path) return failure('INVALID_SAVE_PATH', 'save_sheet needs an absolute path')
      const saved = await handlers.saveTo(path, payload.overwrite === true)
      if (!saved.ok)
        return failure('SAVE_FAILED', saved.error ?? 'the spreadsheet could not be saved')
      return {
        ok: true,
        summary: `Saved the workbook to ${saved.path ?? path}.`,
        warnings: [],
        data: jsonValue(saved),
      }
    }
    return failure('UNKNOWN_COMMAND', `unknown command: ${command.command}`)
  } catch (error) {
    const code = error instanceof SheetsCommandError ? error.code : 'SHEETS_COMMAND_FAILED'
    return failure(code, error instanceof Error ? error.message : String(error))
  }
}
