import { createHash } from 'node:crypto'

import type { AgentToolResult, OperationId } from '@nexusdesk/protocol'

export type OperationStoreErrorCode =
  | 'OPERATION_ID_COLLISION'
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_TERMINAL'

export class OperationStoreError extends Error {
  constructor(readonly code: OperationStoreErrorCode, message: string) {
    super(message)
    this.name = 'OperationStoreError'
  }
}

export interface ReservedOperation {
  state: 'reserved'
  payloadHash: string
}

export interface CommittedOperation {
  state: 'committed'
  payloadHash: string
  result: AgentToolResult
}

export interface FailedOperation {
  state: 'failed'
  payloadHash: string
  result: AgentToolResult
}

export type OperationRecord = ReservedOperation | CommittedOperation | FailedOperation

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('operation payload numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, seen)).join(',')}]`
  if (typeof value !== 'object') throw new TypeError('operation payload must contain JSON values only')
  if (seen.has(value)) throw new TypeError('operation payload must not contain cycles')
  seen.add(value)
  const record = value as Record<string, unknown>
  const encoded = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`)
    .join(',')
  seen.delete(value)
  return `{${encoded}}`
}

function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

/** Keeps operation identity stable across retries, disconnects, and late replies. */
export class OperationStore {
  private readonly operations = new Map<OperationId, OperationRecord>()

  reserve(operationId: OperationId, payload: unknown): OperationRecord {
    const hash = payloadHash(payload)
    const existing = this.operations.get(operationId)
    if (existing !== undefined) {
      if (existing.payloadHash !== hash) {
        throw new OperationStoreError(
          'OPERATION_ID_COLLISION',
          `operation ${operationId} was already bound to a different payload`,
        )
      }
      return existing
    }
    const reserved: ReservedOperation = { state: 'reserved', payloadHash: hash }
    this.operations.set(operationId, reserved)
    return reserved
  }

  commit(operationId: OperationId, result: AgentToolResult): CommittedOperation {
    const record = this.requireReserved(operationId)
    const committed: CommittedOperation = { state: 'committed', payloadHash: record.payloadHash, result }
    this.operations.set(operationId, committed)
    return committed
  }

  fail(operationId: OperationId, result: AgentToolResult): FailedOperation {
    const record = this.requireReserved(operationId)
    const failed: FailedOperation = { state: 'failed', payloadHash: record.payloadHash, result }
    this.operations.set(operationId, failed)
    return failed
  }

  lookup(operationId: OperationId): OperationRecord | undefined {
    return this.operations.get(operationId)
  }

  private requireReserved(operationId: OperationId): ReservedOperation {
    const record = this.operations.get(operationId)
    if (record === undefined) {
      throw new OperationStoreError('OPERATION_NOT_FOUND', `operation ${operationId} was not reserved`)
    }
    if (record.state !== 'reserved') {
      throw new OperationStoreError('OPERATION_TERMINAL', `operation ${operationId} is already ${record.state}`)
    }
    return record
  }
}
