import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { Revision } from '@nexusdesk/protocol'

export type OfficeEditorType = 'sheets' | 'docs' | 'slides'

export interface SheetsOfficeSelection {
  kind: 'sheets'
  sheetId: string
  a1: string | null
  columns?: readonly string[]
}

export interface DocsOfficeSelection {
  kind: 'docs'
  startIndex: number
  endIndex: number
  isRange: boolean
  from?: number
  to?: number
}

export interface SlidesOfficeSelection {
  kind: 'slides'
  slide: number
  elements: readonly string[]
}

export type OfficeSelection =
  | SheetsOfficeSelection
  | DocsOfficeSelection
  | SlidesOfficeSelection

export interface OfficeTurnContext {
  hostId: string
  documentId: string
  editorType: OfficeEditorType
  revision: Revision
  selection: OfficeSelection
}

interface PersistedBinding {
  hostId: string
  documentId: string
  sessionId: string
}

interface PersistedBindingMap {
  version: 1
  bindings: PersistedBinding[]
}

interface BindingLockOwner {
  version: 1
  token: string
  pid: number
}

interface BindingLockOptions {
  lockTimeoutMs?: number
  lockRetryMs?: number
}

const BINDING_FILE = 'office-session-bindings.json'
const BINDING_LOCK_DIRECTORY = '.office-session-bindings.lock'
const BINDING_LOCK_OWNER_FILE = 'owner.json'
const BINDING_LOCK_TIMEOUT_MS = 5_000
const BINDING_LOCK_RETRY_MS = 10
const MAX_SHEET_SELECTION_CELLS = 10_000
const MAX_SLIDE_SELECTION_ELEMENTS = 256
const MAX_DOCUMENT_POSITION = 100_000_000
const A1_RANGE = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid Office ${label}.`)
  }
  return value
}

function boundedInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Invalid Office ${label}.`)
  }
  return value as number
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`Invalid Office ${label}.`)
  }
}

function columnNumber(column: string): number {
  let result = 0
  for (const character of column.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64
  }
  return result
}

function validateA1Range(value: string): string {
  const match = A1_RANGE.exec(value)
  if (match === null) throw new Error('Invalid Office sheets selection range.')
  const startColumn = columnNumber(match[1]!)
  const startRow = Number(match[2])
  const endColumn = columnNumber(match[3] ?? match[1]!)
  const endRow = Number(match[4] ?? match[2])
  if (
    startColumn < 1 || startColumn > 16_384 || endColumn < startColumn || endColumn > 16_384 ||
    startRow < 1 || startRow > 1_048_576 || endRow < startRow || endRow > 1_048_576
  ) {
    throw new Error('Invalid Office sheets selection range.')
  }
  const cells = (endColumn - startColumn + 1) * (endRow - startRow + 1)
  if (cells > MAX_SHEET_SELECTION_CELLS) {
    throw new Error('Office sheets selection range is too large.')
  }
  return value.toUpperCase()
}

function validateSelection(editorType: OfficeEditorType, value: unknown): OfficeSelection {
  if (!isRecord(value) || value.kind !== editorType) {
    throw new Error('Office selection does not match its editor.')
  }
  if (editorType === 'sheets') {
    strictKeys(value, ['kind', 'sheetId', 'a1', 'columns'], 'sheets selection')
    const a1 = value.a1 === null
      ? null
      : validateA1Range(boundedString(value.a1, 'sheets selection range', 32))
    if (value.columns !== undefined && (!Array.isArray(value.columns) || value.columns.length > 256)) {
      throw new Error('Invalid Office sheets selection columns.')
    }
    const columns = value.columns === undefined
      ? undefined
      : Object.freeze(value.columns.map((column) =>
          boundedString(column, 'sheets selection column', 255),
        ))
    return Object.freeze({
      kind: 'sheets',
      sheetId: boundedString(value.sheetId, 'sheets selection sheet identity', 256),
      a1,
      ...(columns === undefined ? {} : { columns }),
    })
  }
  if (editorType === 'docs') {
    strictKeys(value, ['kind', 'startIndex', 'endIndex', 'isRange', 'from', 'to'], 'docs selection')
    const startIndex = boundedInteger(value.startIndex, 'docs selection start', MAX_DOCUMENT_POSITION)
    const endIndex = boundedInteger(value.endIndex, 'docs selection end', MAX_DOCUMENT_POSITION)
    if (startIndex > endIndex || typeof value.isRange !== 'boolean') {
      throw new Error('Invalid Office docs selection.')
    }
    const from = value.from === undefined
      ? undefined
      : boundedInteger(value.from, 'docs selection from', MAX_DOCUMENT_POSITION)
    const to = value.to === undefined
      ? undefined
      : boundedInteger(value.to, 'docs selection to', MAX_DOCUMENT_POSITION)
    if ((from === undefined) !== (to === undefined) || (from !== undefined && to !== undefined && from > to)) {
      throw new Error('Invalid Office docs selection positions.')
    }
    return Object.freeze({
      kind: 'docs', startIndex, endIndex, isRange: value.isRange,
      ...(from === undefined || to === undefined ? {} : { from, to }),
    })
  }
  strictKeys(value, ['kind', 'slide', 'elements'], 'slides selection')
  if (!Array.isArray(value.elements) || value.elements.length > MAX_SLIDE_SELECTION_ELEMENTS) {
    throw new Error('Invalid Office slides selection elements.')
  }
  const elements = value.elements.map((element) =>
    boundedString(element, 'slides selection element', 256),
  )
  if (new Set(elements).size !== elements.length) {
    throw new Error('Invalid Office slides selection elements.')
  }
  return Object.freeze({
    kind: 'slides',
    slide: boundedInteger(value.slide, 'slides selection slide', 100_000),
    elements: Object.freeze(elements),
  })
}

/** Validate Host-owned identity/revision and snapshot the renderer's bounded selection. */
export function freezeOfficeTurnContext(value: unknown): OfficeTurnContext {
  if (!isRecord(value)) throw new Error('Invalid Office turn context.')
  strictKeys(value, ['hostId', 'documentId', 'editorType', 'revision', 'selection'], 'turn context')
  if (value.editorType !== 'sheets' && value.editorType !== 'docs' && value.editorType !== 'slides') {
    throw new Error('Invalid Office editor type.')
  }
  const revision = boundedInteger(value.revision, 'revision') as Revision
  return Object.freeze({
    hostId: boundedString(value.hostId, 'Host identity', 256),
    documentId: boundedString(value.documentId, 'document identity', 512),
    editorType: value.editorType,
    revision,
    selection: validateSelection(value.editorType, value.selection),
  })
}

function validateBindingMap(value: unknown): PersistedBindingMap {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.bindings)) {
    throw new Error('Invalid Office Session binding map.')
  }
  const keys = new Set<string>()
  const sessions = new Set<string>()
  const bindings = value.bindings.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid Office Session binding map.')
    strictKeys(entry, ['hostId', 'documentId', 'sessionId'], 'Session binding map')
    const binding = {
      hostId: boundedString(entry.hostId, 'Host identity', 256),
      documentId: boundedString(entry.documentId, 'document identity', 512),
      sessionId: boundedString(entry.sessionId, 'Session identity', 256),
    }
    const key = JSON.stringify([binding.hostId, binding.documentId])
    if (keys.has(key) || sessions.has(binding.sessionId)) {
      throw new Error('Invalid Office Session binding map.')
    }
    keys.add(key)
    sessions.add(binding.sessionId)
    return binding
  })
  return { version: 1, bindings }
}

function parseBindingLockOwner(value: unknown): BindingLockOwner | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.token) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0
  ) {
    return undefined
  }
  return { version: 1, token: value.token, pid: value.pid as number }
}

async function readBindingLockOwner(lockPath: string): Promise<BindingLockOwner | undefined> {
  try {
    return parseBindingLockOwner(JSON.parse(
      await readFile(join(lockPath, BINDING_LOCK_OWNER_FILE), 'utf8'),
    ))
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Durable identity map only; conversation history remains in official Session persistence. */
export class OfficeSessionBindingStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly stateDirectory: string,
    private readonly createSessionId: () => string = () => `office-${randomUUID()}`,
    private readonly lockOptions: BindingLockOptions = {},
  ) {}

  bindOfficeSession(hostId: string, documentId: string): Promise<string> {
    const operation = this.queue.then(
      () => this.bindWithLock(hostId, documentId),
      () => this.bindWithLock(hostId, documentId),
    )
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async bindWithLock(hostId: string, documentId: string): Promise<string> {
    await mkdir(this.stateDirectory, { recursive: true })
    const lockPath = join(this.stateDirectory, BINDING_LOCK_DIRECTORY)
    const lockTimeoutMs = this.lockOptions.lockTimeoutMs ?? BINDING_LOCK_TIMEOUT_MS
    const lockRetryMs = this.lockOptions.lockRetryMs ?? BINDING_LOCK_RETRY_MS
    const startedAt = Date.now()
    let release: (() => Promise<void>) | undefined
    while (true) {
      release = await this.tryAcquireBindingLock(lockPath)
      if (release !== undefined) break
      const owner = await readBindingLockOwner(lockPath)
      if (owner !== undefined && !processIsAlive(owner.pid)) {
        const recoveredPath = join(
          this.stateDirectory,
          `.office-session-bindings.recovered-${owner.token}`,
        )
        try {
          await rename(lockPath, recoveredPath)
          continue
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
        }
      }
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error('Timed out waiting for the Office Session binding map lock.')
      }
      await delay(lockRetryMs)
    }
    try {
      return await this.bind(hostId, documentId)
    } finally {
      await release()
    }
  }

  private async tryAcquireBindingLock(
    lockPath: string,
  ): Promise<(() => Promise<void>) | undefined> {
    const token = randomUUID()
    const candidatePath = join(
      this.stateDirectory,
      `.office-session-bindings.candidate-${token}`,
    )
    await mkdir(candidatePath, { mode: 0o700 })
    await writeFile(
      join(candidatePath, BINDING_LOCK_OWNER_FILE),
      `${JSON.stringify({ version: 1, token, pid: process.pid } satisfies BindingLockOwner)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    try {
      await rename(candidatePath, lockPath)
    } catch (error) {
      await rm(candidatePath, { recursive: true, force: true })
      // The owner may release its lock before contender cleanup finishes.
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'ENOTEMPTY') return undefined
      throw error
    }
    return async () => {
      const owner = await readBindingLockOwner(lockPath)
      if (owner?.token !== token || owner.pid !== process.pid) {
        throw new Error('Could not release the owned Office Session binding map lock.')
      }
      await rm(lockPath, { recursive: true })
    }
  }

  private async bind(hostIdValue: string, documentIdValue: string): Promise<string> {
    const hostId = boundedString(hostIdValue, 'Host identity', 256)
    const documentId = boundedString(documentIdValue, 'document identity', 512)
    const path = join(this.stateDirectory, BINDING_FILE)
    let state: PersistedBindingMap = { version: 1, bindings: [] }
    try {
      state = validateBindingMap(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Could not read the Office Session binding map.', { cause: error })
      }
    }
    const existing = state.bindings.find(
      (binding) => binding.hostId === hostId && binding.documentId === documentId,
    )
    if (existing !== undefined) return existing.sessionId
    const sessionId = boundedString(this.createSessionId(), 'Session identity', 256)
    if (state.bindings.some((binding) => binding.sessionId === sessionId)) {
      throw new Error('Office Session identity is already bound.')
    }
    const next: PersistedBindingMap = {
      version: 1,
      bindings: [...state.bindings, { hostId, documentId, sessionId }],
    }
    const temporary = join(this.stateDirectory, `.${BINDING_FILE}.${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
    return sessionId
  }
}

export interface OfficeAgentHandle {
  agent: {
    inbox: { readonly hasPending: boolean; clear(): void }
    [key: string]: unknown
  }
  dispose(): Promise<void> | void
}

export interface AcquireOfficeAgentInput {
  sessionId: string
  cwd: string
  setup: unknown
  agentOptions: unknown
  sessionPersistence: { stat(sessionId: string): Promise<unknown | undefined> }
  agents: {
    create(options: unknown): Promise<OfficeAgentHandle>
    resume(options: unknown): Promise<OfficeAgentHandle>
  }
}

/** Acquire an official Session, clearing crash-surviving queued input before publication to callers. */
export async function acquireOfficeAgent(
  input: AcquireOfficeAgentInput,
): Promise<{ handle: OfficeAgentHandle; resumed: boolean }> {
  const snapshot = await input.sessionPersistence.stat(input.sessionId)
  if (snapshot === undefined) {
    const handle = await input.agents.create({
      sessionId: input.sessionId,
      meta: { cwd: input.cwd },
      agentOptions: input.agentOptions,
      setup: input.setup,
    })
    return { handle, resumed: false }
  }
  const handle = await input.agents.resume({
    resumeSessionId: input.sessionId,
    agentOptions: input.agentOptions,
    setup: input.setup,
  })
  try {
    if (handle.agent.inbox.hasPending) handle.agent.inbox.clear()
  } catch (error) {
    await Promise.resolve(handle.dispose()).catch(() => undefined)
    throw error
  }
  return { handle, resumed: true }
}

/** Render context that Task 3 prepends to the one official Session prompt request. */
export function officeTurnContextText(context: OfficeTurnContext): string {
  const visibleContext = {
    documentId: context.documentId,
    editorType: context.editorType,
    revision: context.revision,
    selection: context.selection,
  }
  return `NexusDesk Office context (Host-validated and frozen at submission):\n${JSON.stringify(visibleContext)}`
}
