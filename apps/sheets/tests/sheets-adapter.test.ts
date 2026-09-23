import { describe, expect, it, vi } from 'vitest'

import type {
  ApprovedEditPlan,
  ClientId,
  DocumentId,
  EditRequest,
  OperationId,
  Revision,
  SessionId,
} from '@nexusdesk/protocol'
import { parseAgentToolResult } from '@nexusdesk/protocol'
import {
  createSheetsAdapter,
  type SheetsAdapterOptions,
} from '../src/renderer/agent/sheets-adapter'
import type { McpSheetHandlers } from '../src/renderer/agent/sheets-command'
import { setModuleLang } from '../src/renderer/i18n/locale'

const documentId = 'document-1' as DocumentId
const clientId = 'client-1' as ClientId
const revision = 1 as Revision

function handlersWith(overrides: Partial<McpSheetHandlers> = {}): McpSheetHandlers {
  return {
    hasWorkbook: () => true,
    context: () => ({ title: 'Forecast' }),
    readCells: () => ({}),
    sheets: () => [{ id: 'sheet-1', name: 'Summary' }],
    focusSheet: vi.fn(),
    applyOps: vi.fn().mockResolvedValue({ ok: true }),
    saveTo: vi.fn().mockResolvedValue({ ok: true }),
    saveInPlace: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
}

function editRequest(overrides: Partial<EditRequest> = {}): EditRequest {
  return {
    sessionId: 'session-1' as SessionId,
    documentId,
    editorType: 'sheets',
    revision,
    operationId: 'operation-1' as OperationId,
    clientId,
    command: 'apply_ops',
    arguments: {
      ops: [{ op: 'set_cell', sheet: 'Summary', address: 'B2', value: 5 }],
    },
    ...overrides,
  }
}

function setup(overrides: Partial<SheetsAdapterOptions> = {}) {
  const handlers = overrides.handlers ?? handlersWith()
  const options: SheetsAdapterOptions = {
    handlers,
    document: () => ({ documentId, clientId, revision, title: 'Forecast', attached: true }),
    consumeApproval: () => true,
    verify: async () => ({ passed: true, issues: [] }),
    rollback: vi.fn().mockResolvedValue(true),
    commitRevision: vi.fn(),
    ...overrides,
  }
  return { adapter: createSheetsAdapter(options), handlers, options }
}

async function approvedPlan(options: Partial<SheetsAdapterOptions> = {}) {
  const fixture = setup(options)
  const plan = await fixture.adapter.propose(editRequest())
  return {
    ...fixture,
    plan: { ...plan, approvalId: 'approval-1' } as ApprovedEditPlan,
  }
}

describe('Sheets editor adapter', () => {
  it('describes the exact cell edit in user-facing approval language', async () => {
    const { adapter } = setup()
    const plan = await adapter.propose(editRequest())
    expect(plan.summary).toContain('Summary!B2')
    expect(plan.summary).toContain('写入 5')
    expect(plan.summary).not.toContain('set_cell')
  })
  it('shows English chart and cell approval copy when the editor language is English', async () => {
    setModuleLang('en')
    try {
      const { adapter } = setup()
      const plan = await adapter.propose(editRequest({
        arguments: { ops: [
          { op: 'set_cell', sheet: 'Summary', address: 'B2', value: 5 },
          { op: 'add_chart', sheet: 'Summary', chartType: 'column', dataRange: 'A4:B10', title: 'H1 2026 Sales', anchorCell: 'D4' },
        ] },
      }))

      expect(plan.summary).toContain('1. Write 5 to Summary!B2')
      expect(plan.summary).toContain('2. Create chart “H1 2026 Sales” on Summary using A4:B10')
      expect(plan.summary).toContain('A4:B10.\nOnly the changes above')
      expect(plan.summary).toContain('Saving the file requires separate confirmation.')
      expect(plan.summary).not.toMatch(/[\u3400-\u9fff]/)
    } finally {
      setModuleLang('zh')
    }
  })
  it('proposes normalized operations without mutating the workbook', async () => {
    const applyOps = vi.fn()
    const { adapter } = setup({ handlers: handlersWith({ applyOps }) })

    const plan = await adapter.propose(editRequest())

    expect(plan.operations).toEqual([
      { op: 'set_cell', sheetId: 'sheet-1', address: 'B2', value: 5 },
    ])
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(applyOps).not.toHaveBeenCalled()
  })

  it('requires approval for the exact immutable plan hash', async () => {
    let allowedHash = ''
    const consumeApproval = vi.fn((_id: string, hash: string) => hash === allowedHash)
    const { adapter, plan, handlers } = await approvedPlan({ consumeApproval })
    allowedHash = plan.planHash
    const tampered = {
      ...plan,
      operations: [{ op: 'set_cell', sheetId: 'sheet-1', address: 'B2', value: 999 }],
    } as ApprovedEditPlan

    const result = await adapter.apply(tampered)

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'PLAN_TAMPERED' })],
    })
    expect(handlers.applyOps).not.toHaveBeenCalled()
  })

  it.each([
    ['stale revision', { revision: 2 as Revision }, { revision: 1 as Revision }, 'STALE_REVISION'],
    ['wrong browser client', { clientId: 'client-2' as ClientId }, {}, 'WRONG_CLIENT'],
  ])('rejects %s immediately before applying', async (_label, current, request, code) => {
    const applyOps = vi.fn()
    const { adapter } = setup({
      handlers: handlersWith({ applyOps }),
      document: () => ({
        documentId,
        clientId,
        revision,
        title: 'Forecast',
        attached: true,
        ...current,
      }),
    })
    const proposed = await adapter.propose(editRequest(request))
    const result = await adapter.apply({ ...proposed, approvalId: 'approval-1' })

    expect(result).toMatchObject({ ok: false, warnings: [expect.objectContaining({ code })] })
    expect(applyOps).not.toHaveBeenCalled()
  })

  it('applies one operation batch once and replays its recorded agent result by operation id', async () => {
    const applyOps = vi.fn().mockResolvedValue({ ok: true, engine: { unsafe: true } })
    const { adapter, plan } = await approvedPlan({ handlers: handlersWith({ applyOps }) })

    const first = await adapter.apply(plan)
    const replayed = await adapter.apply(plan)

    expect(applyOps).toHaveBeenCalledTimes(1)
    expect(applyOps).toHaveBeenCalledWith(plan.operations, false)
    expect(first).toEqual(replayed)
    expect(first).toMatchObject({
      ok: true,
      changes: { targets: ['Summary!B2'], count: 1 },
      verification: { passed: true, issues: [] },
      transactionId: expect.any(String),
    })
    expect(JSON.stringify(first)).not.toContain('unsafe')
    expect(JSON.stringify(first)).not.toContain('engine')
  })

  it('projects save details into the strict Agent result envelope', async () => {
    const { adapter } = setup()

    const result = await adapter.save(documentId)

    expect(result).not.toHaveProperty('data')
    expect(() => parseAgentToolResult(result)).not.toThrow()
  })

  it('projects export details into the strict Agent result envelope', async () => {
    const { adapter } = setup()

    const result = await adapter.export({
      documentId,
      format: 'xlsx',
      destination: '/work/export.xlsx',
    })

    expect(result).not.toHaveProperty('data')
    expect(() => parseAgentToolResult(result)).not.toThrow()
  })

  it('rolls back the transaction when post-apply verification fails', async () => {
    const rollback = vi.fn().mockResolvedValue(true)
    const { adapter, plan } = await approvedPlan({
      verify: async () => ({
        passed: false,
        issues: [{ code: 'FORMULA_ERROR', message: 'B2 evaluates to #REF!', target: 'Summary!B2' }],
      }),
      rollback,
    })

    const result = await adapter.apply(plan)

    expect(rollback).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledWith(result.transactionId)
    expect(result).toMatchObject({
      ok: false,
      verification: { passed: false, issues: [expect.objectContaining({ code: 'FORMULA_ERROR' })] },
      warnings: [expect.objectContaining({ code: 'ROLLED_BACK' })],
    })
  })

  it('rolls back a partially applied executor failure', async () => {
    const rollback = vi.fn().mockResolvedValue(true)
    const { adapter, plan } = await approvedPlan({
      handlers: handlersWith({
        applyOps: vi.fn().mockResolvedValue({
          ok: false,
          reason: 'second operation failed',
          partiallyApplied: true,
          undoDropped: false,
        }),
      }),
      rollback,
    })

    const result = await adapter.apply(plan)

    expect(rollback).toHaveBeenCalledWith(result.transactionId)
    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'ROLLED_BACK' })],
    })
  })

  it('rolls back when apply or verification throws', async () => {
    const applyRollback = vi.fn().mockResolvedValue(true)
    const applyFixture = await approvedPlan({
      handlers: handlersWith({ applyOps: vi.fn().mockRejectedValue(new Error('engine stopped')) }),
      rollback: applyRollback,
    })
    const verifyRollback = vi.fn().mockResolvedValue(true)
    const verifyFixture = await approvedPlan({
      verify: async () => {
        throw new Error('recalculation stopped')
      },
      rollback: verifyRollback,
    })

    const applyResult = await applyFixture.adapter.apply(applyFixture.plan)
    const verifyResult = await verifyFixture.adapter.apply(verifyFixture.plan)

    expect(applyRollback).toHaveBeenCalledTimes(1)
    expect(verifyRollback).toHaveBeenCalledTimes(1)
    expect(applyResult.warnings[0]?.code).toBe('ROLLED_BACK')
    expect(verifyResult.warnings[0]?.code).toBe('ROLLED_BACK')
  })

  it('never claims rollback success when the transaction cannot be restored', async () => {
    const { adapter, plan } = await approvedPlan({
      handlers: handlersWith({
        applyOps: vi
          .fn()
          .mockResolvedValue({ ok: false, reason: 'failed', partiallyApplied: true }),
      }),
      rollback: vi.fn().mockResolvedValue(false),
    })

    const result = await adapter.apply(plan)

    expect(result).toMatchObject({
      ok: false,
      warnings: [expect.objectContaining({ code: 'ROLLBACK_FAILED' })],
    })
    expect(result.summary).toMatch(/may remain/i)
  })
})
