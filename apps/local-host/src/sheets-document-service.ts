import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { HostError } from '@nexusdesk/office-host'
import { XlsxSidecarClient } from '../../sheets/src/main/xlsx-sidecar-client'
import {
  workbookFileSchema,
  workbookFormulaCellsRequestSchema,
  workbookFormulaCellsResultSchema,
  workbookRangeRequestSchema,
  workbookRangeResultSchema,
  workbookRecalcRequestSchema,
  workbookRecalcResultSchema,
  workbookMediaRequestSchema,
  workbookMediaResultSchema,
  workbookPivotRequestSchema,
  workbookPivotDefinitionSchema,
  type WorkbookFile,
  type WorkbookSaveRequest,
} from '../../sheets/src/shared/desktop-api'
import {
  buildWorkbookSavePlan,
  decodeWorkbookSaveRequest,
} from '../../sheets/src/shared/workbook-save-plan'
import {
  saveWorkbookViaSidecar,
  readArchiveEntryText,
} from '@genoffice/xlsx-gateway/gateway/xlsx-package-io'
import { parsePivotDefinition } from '@genoffice/xlsx-gateway/gateway/xlsx-pivot'
import { createWorkingCopyStore } from './working-copy-store'
import {
  defaultWorkingCopyRoot,
  type LocalDocument,
  type LocalDocumentDriver,
  type WorkingCopyDriverOptions,
} from './document-driver'

interface OpenWorkbook {
  file: WorkbookFile
  sheetNames: Map<string, string>
  sourceContentId: string
  snapshotPath: string
  workingRevision: number
  savedRevision: number
  documentEpoch: string
  expiresAt: number
}
function sidecarPath(repositoryRoot: string): string {
  return resolve(
    repositoryRoot,
    'apps/sheets/native/xlsx-engine/target/release',
    process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar',
  )
}
export async function createSheetsDocumentService(
  repositoryRoot: string,
  path: string,
  options: WorkingCopyDriverOptions = {},
): Promise<{ drivers: LocalDocumentDriver[]; close(): Promise<void> }> {
  const client = new XlsxSidecarClient(sidecarPath(repositoryRoot))
  const directory = await mkdtemp(join(tmpdir(), 'nexusdesk-sheets-'))
  let opened: OpenWorkbook | undefined
  let closed = false
  const retiredSessions = new Set<string>()
  const sessions = new Map<string, OpenWorkbook>()
  const document: LocalDocument = {
    documentId: 'xlsx-' + createHash('sha256').update(path).digest('hex').slice(0, 16),
    title: basename(path),
    editorType: 'sheets',
    revision: 1,
    path,
  }
  const store = await createWorkingCopyStore({
    rootDirectory: options.workingCopyRoot ?? defaultWorkingCopyRoot(),
    authorizedPath: path,
    documentId: document.documentId,
    editorType: 'sheets',
    initialSavedRevision: 1,
  })
  const snapshot = async (sourceContentId: string): Promise<string> => {
    const bytes = await store.readSource(sourceContentId)
    const snapshotPath = join(directory, sourceContentId + '.xlsx')
    try {
      await writeFile(snapshotPath, bytes, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readFile(snapshotPath)
      if (createHash('sha256').update(existing).digest('hex') !== sourceContentId)
        throw new Error('Invalid workbook source snapshot.', { cause: error })
    }
    return snapshotPath
  }
  const sheetNamesFor = (raw: { sheets: { id: string; name: string }[] }) =>
    new Map(raw.sheets.map((sheet) => [sheet.id, sheet.name]))
  const openWorkbook = async (): Promise<OpenWorkbook> => {
    const before = await store.getStatus()
    if (before.recoveryState !== 'ready')
      throw new HostError(
        'REVISION_CONFLICT',
        'The original workbook changed; recovery needs attention.',
        false,
      )
    const source = await store.acquireSource()
    const snapshotPath = await snapshot(source.sourceContentId)
    const raw = (await client.open(snapshotPath, 'en')) as {
      sessionId: string
      sheets: { id: string; name: string }[]
    }
    try {
      const after = await store.getStatus()
      if (
        before.workingRevision !== after.workingRevision ||
        before.savedRevision !== after.savedRevision ||
        before.documentEpoch !== after.documentEpoch
      ) {
        throw new HostError(
          'REVISION_CONFLICT',
          'Workbook changed during hydration; bootstrap again.',
          true,
        )
      }
      const file = workbookFileSchema.parse({
        ...raw,
        name: basename(path),
        path,
        sha256: source.sourceContentId,
        fileBytes: source.bytes.length,
        readOnly: false,
        needsSaveAs: false,
        restoredFromRecovery: after.dirty,
        automaticRecoveryDisabled: true,
      })
      document.revision = after.workingRevision
      return {
        file,
        sheetNames: sheetNamesFor(raw),
        sourceContentId: source.sourceContentId,
        snapshotPath,
        workingRevision: after.workingRevision,
        savedRevision: after.savedRevision,
        documentEpoch: after.documentEpoch,
        expiresAt: Date.now() + 600_000,
      }
    } catch (error) {
      await client.close(raw.sessionId).catch(() => undefined)
      throw error
    }
  }
  const requireSession = (payload: unknown): OpenWorkbook => {
    const state = sessions.get((payload as { sessionId?: string } | null)?.sessionId ?? '')
    if (!state || (state !== opened && state.expiresAt <= Date.now())) {
      throw new HostError('DOCUMENT_NOT_FOUND', 'Unknown or obsolete workbook session.', false)
    }
    return state
  }
  const retire = async (state: OpenWorkbook) => {
    sessions.delete(state.file.sessionId)
    retiredSessions.add(state.file.sessionId)
    await client.close(state.file.sessionId).catch(() => undefined)
  }
  const validateCandidate = async (state: OpenWorkbook) => {
    const current = await store.getStatus()
    if (
      current.recoveryState !== 'ready' ||
      current.workingRevision !== state.workingRevision ||
      current.savedRevision !== state.savedRevision ||
      current.documentEpoch !== state.documentEpoch
    ) {
      if (state !== opened) await retire(state)
      throw new HostError(
        'REVISION_CONFLICT',
        'Workbook head changed after native hydration; bootstrap again.',
        true,
      )
    }
  }
  const driver: LocalDocumentDriver = {
    document,
    workingCopy: {
      store,
      async acquireSource(editorSessionId) {
        if (editorSessionId) {
          const expected = requireSession({ sessionId: editorSessionId })
          await validateCandidate(expected)
          return {
            sourceContentId: expected.sourceContentId,
            bytes: await store.readSource(expected.sourceContentId),
          }
        }
        return store.acquireSource()
      },
      async activateSource(sourceContentId, editorSessionId) {
        const candidate = requireSession({ sessionId: editorSessionId })
        if (candidate.sourceContentId !== sourceContentId) {
          if (candidate !== opened) await retire(candidate)
          throw new HostError(
            'REVISION_CONFLICT',
            'Native session does not match the leased source.',
            true,
          )
        }
        if (candidate === opened) return
        await validateCandidate(candidate)
        const previous = opened
        opened = candidate
        if (previous) await retire(previous)
      },
      async discardSource(editorSessionId) {
        const candidate = sessions.get(editorSessionId ?? '')
        if (candidate && candidate !== opened) await retire(candidate)
      },
      readSource: (id) => store.readSource(id),
      async materialize(input) {
        if (input.payloadKind !== 'xlsx-save-plan')
          throw new Error('Sheets requires an XLSX save plan.')
        const request = decodeWorkbookSaveRequest(input.parts)
        const state = requireSession(request)
        if (state !== opened) throw new Error('Workbook session is not the registered owner.')
        if (state.sourceContentId !== input.sourceContentId)
          throw new Error('Workbook plan belongs to a different source session.')
        const sourcePath = await snapshot(input.sourceContentId)
        const workDir = await mkdtemp(join(directory, 'materialize-'))
        const targetPath = join(workDir, 'prepared.xlsx')
        try {
          const hasShifts = request.structuralOps.length > 0 || request.sheetOps.length > 0
          const heldPivots = hasShifts ? request.pivotAdditions : []
          const heldTables = request.structuralOps.length > 0 ? request.tableAdditions : []
          const heldNames = hasShifts ? request.definedNamesState : null
          const split = heldPivots.length > 0 || heldTables.length > 0 || heldNames !== null
          const addedIds = new Set(
            request.sheetOps.flatMap((op) =>
              op.kind === 'add-sheet' || op.kind === 'duplicate-sheet' ? [op.sheetId] : [],
            ),
          )
          if (
            [
              ...heldPivots.flatMap((p) => [p.sheetId, p.sourceSheetId]),
              ...heldTables.map((t) => t.sheetId),
            ].some((id) => addedIds.has(id))
          ) {
            throw new Error('Held table/pivot additions cannot target a newly added sheet.')
          }
          await saveWorkbookViaSidecar({
            client,
            sourcePath,
            targetPath,
            ...buildWorkbookSavePlan(
              {
                ...request,
                tableAdditions: heldTables.length ? [] : request.tableAdditions,
                pivotAdditions: heldPivots.length ? [] : request.pivotAdditions,
                definedNamesState: split ? null : request.definedNamesState,
              },
              state.sheetNames,
            ),
          })
          if (split) {
            const stage = (await client.open(targetPath, 'en')) as {
              sessionId: string
              sheets: { id: string; name: string }[]
            }
            try {
              // Only held operations run against phase one's isolated bytes. The cumulative
              // journal is never applied to a previously published checkpoint.
              const held: WorkbookSaveRequest = {
                ...request,
                edits: [],
                bulkConstantFills: [],
                structuralOps: [],
                chartEdits: [],
                visualEdits: [],
                visualAdditions: [],
                tableAdditions: heldTables,
                pivotAdditions: heldPivots,
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
                definedNamesState: heldNames,
                themeState: null,
                workbookProtectionState: null,
                protectedRangeStates: [],
              }
              await saveWorkbookViaSidecar({
                client,
                sourcePath: targetPath,
                targetPath,
                ...buildWorkbookSavePlan(held, sheetNamesFor(stage)),
              })
            } finally {
              await client.close(stage.sessionId)
            }
          }
          // Fully reopen the final ZIP before it can enter the durable store.
          const verified = (await client.open(targetPath, 'en')) as { sessionId: string }
          await client.close(verified.sessionId)
          return new Uint8Array(await readFile(targetPath))
        } finally {
          await rm(workDir, { recursive: true, force: true })
        }
      },
    },
    async bootstrap(origin) {
      for (const candidate of sessions.values())
        if (candidate !== opened && candidate.expiresAt <= Date.now()) await retire(candidate)
      if (sessions.size >= 64)
        throw new HostError(
          'REVISION_CONFLICT',
          'Too many pending workbook sessions; close unused pages and retry.',
          true,
        )
      const next = await openWorkbook()
      sessions.set(next.file.sessionId, next)
      return {
        documentId: document.documentId,
        title: document.title,
        revision: document.revision,
        websocketUrl: origin.replace(/^http/, 'ws') + '/ws',
        language: 'en',
        theme: 'system',
        workbook: next.file,
      }
    },
    async execute(action, payload) {
      if (action === 'save-workbook' || action === 'write-workbook-recovery')
        throw new HostError(
          'UNSUPPORTED_CAPABILITY',
          'Use the authorized working-copy save lane.',
          false,
        )
      if (
        action === 'close-workbook' &&
        retiredSessions.has((payload as { sessionId: string }).sessionId)
      )
        return { ok: true }
      const state = requireSession(payload)
      if (action === 'read-workbook-range')
        return workbookRangeResultSchema.parse(
          await client.readRange(workbookRangeRequestSchema.parse(payload)),
        )
      if (action === 'read-workbook-formulas')
        return workbookFormulaCellsResultSchema.parse(
          await client.readFormulaCells(workbookFormulaCellsRequestSchema.parse(payload)),
        )
      if (action === 'read-workbook-media')
        return workbookMediaResultSchema.parse(
          await client.readMedia(workbookMediaRequestSchema.parse(payload)),
        )
      if (action === 'read-pivot-definition') {
        const request = workbookPivotRequestSchema.parse(payload)
        const [pivot, cache] = await Promise.all([
          readArchiveEntryText(client, state.snapshotPath, request.path),
          readArchiveEntryText(client, state.snapshotPath, request.cachePath),
        ])
        return workbookPivotDefinitionSchema.parse(parsePivotDefinition(pivot, cache))
      }
      if (action === 'recalculate-workbook') {
        const request = workbookRecalcRequestSchema.parse(payload)
        const name = (id: string) => {
          const value = state.sheetNames.get(id)
          if (!value) throw new Error('Unknown worksheet ' + id)
          return value
        }
        const result = (await client.recalcCells({
          path: state.snapshotPath,
          edits: request.edits.map((edit) => ({
            sheet: name(edit.sheetId),
            row: edit.row,
            column: edit.column,
            input: edit.input,
          })),
          reads: request.reads.map((read) => ({ sheet: name(read.sheetId), range: read.range })),
        })) as { cells: Array<Record<string, unknown> & { sheet: string }> }
        const ids = new Map([...state.sheetNames].map(([id, value]) => [value, id]))
        return workbookRecalcResultSchema.parse({
          cells: result.cells.flatMap(({ sheet, ...cell }) => {
            const sheetId = ids.get(sheet)
            return sheetId === undefined ? [] : [{ ...cell, sheetId }]
          }),
        })
      }
      if (action === 'close-workbook') {
        await retire(state)
        if (opened === state) opened = undefined
        return { ok: true }
      }
      throw new Error('Unsupported Sheets document action: ' + action)
    },
    async close() {
      if (closed) return
      closed = true
      await Promise.all([...sessions.values()].map(retire))
      opened = undefined
      client.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
  return { drivers: [driver], close: () => driver.close() }
}
