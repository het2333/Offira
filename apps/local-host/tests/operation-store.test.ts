import { describe, expect, it } from 'vitest'

import type { AgentToolResult, ClientId, DocumentId, OperationId, Revision } from '@nexusdesk/protocol'
import { DocumentRegistry } from '../src/document-registry'
import { OperationStore, OperationStoreError } from '../src/operation-store'

const operationId = 'operation-1' as OperationId
const result: AgentToolResult = {
  ok: true,
  summary: 'updated Summary!B2',
  changes: { targets: ['Summary!B2'], count: 1 },
  warnings: [],
}

function storeErrorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    if (!(error instanceof OperationStoreError)) throw error
    return error.code
  }
}

describe('OperationStore', () => {
  it('returns the existing reservation for the same canonical payload', () => {
    const store = new OperationStore()
    const first = store.reserve(operationId, { command: 'apply', args: { b: 2, a: 1 } })
    const retry = store.reserve(operationId, { args: { a: 1, b: 2 }, command: 'apply' })

    expect(first).toBe(retry)
    expect(retry.state).toBe('reserved')
  })

  it('rejects reuse of an operation id with a different payload', () => {
    const store = new OperationStore()
    store.reserve(operationId, { command: 'apply', value: 1 })

    expect(storeErrorCode(() => store.reserve(operationId, { command: 'apply', value: 2 })))
      .toBe('OPERATION_ID_COLLISION')
  })

  it('retains a committed result across document disconnect and retry', () => {
    const store = new OperationStore()
    const registry = new DocumentRegistry()
    const documentId = 'document-1' as DocumentId
    const clientId = 'client-1' as ClientId
    registry.register({ documentId, clientId, editorType: 'sheets', revision: 1 as Revision })
    store.reserve(operationId, { command: 'apply', value: 1 })
    store.commit(operationId, result)

    registry.detachClient(clientId)
    const retry = store.reserve(operationId, { command: 'apply', value: 1 })

    expect(retry).toEqual({
      state: 'committed',
      payloadHash: expect.any(String),
      result,
    })
    expect(store.lookup(operationId)).toEqual(retry)
  })

  it('does not allow a terminal operation to transition again', () => {
    const store = new OperationStore()
    store.reserve(operationId, { command: 'apply' })
    store.fail(operationId, { ok: false, summary: 'rejected', warnings: [] })

    expect(storeErrorCode(() => store.commit(operationId, result))).toBe('OPERATION_TERMINAL')
  })
})
