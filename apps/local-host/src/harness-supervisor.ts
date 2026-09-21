import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type { ClientId, DocumentId, Revision, SessionId } from '@nexusdesk/protocol'
import {
  PROTOCOL_VERSION,
  type RuntimeRequestFrame,
  type RuntimeEditorResponseFrame,
  type RuntimeResponseFrame,
} from '@nexusdesk/runtime-host/protocol'
import type { OfficeEditorType } from '@nexusdesk/runtime-host/office-session-binding'

const SHUTDOWN_GRACE_MS = 5_000
const TERM_GRACE_MS = 3_000

export interface HarnessSupervisorOptions {
  entry: string
  args?: string[]
  nodeExecutable?: string
  restartDelayMs?: number
}

export interface StartTurnInput {
  sessionId: SessionId
  documentId: DocumentId
  clientId: ClientId
  editorType: string
  revision: Revision
  cwd: string
  prompt: string
  provider?: string
  model?: string
}

export interface BindOfficeSessionInput {
  hostId: string
  documentId: DocumentId
  clientId: ClientId
  editorType: OfficeEditorType
  revision: Revision
  cwd: string
  provider?: string
  model?: string
}

export interface RuntimeExit {
  code: number | null
  signal: NodeJS.Signals | null
  activeSessions: SessionId[]
}

type FrameListener = (frame: RuntimeResponseFrame) => void
type ExitListener = (exit: RuntimeExit) => void

/** Owns one restartable Harness child without replaying interrupted turns. */
export class HarnessSupervisor {
  private child: ChildProcess | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private stopping = false
  private readonly frames = new Set<FrameListener>()
  private readonly exits = new Set<ExitListener>()
  private readonly activeSessions = new Set<SessionId>()
  private readonly pendingBindings = new Map<
    string,
    {
      resolve(value: { sessionId: SessionId; resumed: boolean }): void
      reject(error: Error): void
    }
  >()
  private readyPromise!: Promise<void>
  private resolveReady!: () => void

  constructor(private readonly options: HarnessSupervisorOptions) {
    this.resetReady()
    this.launch()
  }

  onFrame(listener: FrameListener): () => void {
    this.frames.add(listener)
    return () => this.frames.delete(listener)
  }

  onExit(listener: ExitListener): () => void {
    this.exits.add(listener)
    return () => this.exits.delete(listener)
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  startTurn(input: StartTurnInput): void {
    this.activeSessions.add(input.sessionId)
    this.send({
      type: 'agent:start',
      protocolVersion: PROTOCOL_VERSION,
      id: `turn-${randomUUID()}`,
      ...input,
    })
  }

  bindOfficeSession(
    input: BindOfficeSessionInput,
  ): Promise<{ sessionId: SessionId; resumed: boolean }> {
    const id = `office-bind-${randomUUID()}`
    return new Promise((resolve, reject) => {
      this.pendingBindings.set(id, { resolve, reject })
      try {
        this.send({
          type: 'office:bind',
          protocolVersion: PROTOCOL_VERSION,
          id,
          ...input,
        })
      } catch (error) {
        this.pendingBindings.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  cancelTurn(sessionId: SessionId): void {
    this.send({
      type: 'agent:cancel',
      protocolVersion: PROTOCOL_VERSION,
      id: `cancel-${randomUUID()}`,
      sessionId,
      reason: 'user',
    })
  }

  respondApproval(id: string, outcome: import('@nexusdesk/protocol').ApprovalOutcome): void {
    this.send({ type: 'approval:response', protocolVersion: PROTOCOL_VERSION, id, outcome })
  }

  respondEditor(frame: RuntimeEditorResponseFrame): void {
    this.send(frame)
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    clearTimeout(this.restartTimer)
    const child = this.child
    if (child === undefined) return
    if (child.connected) {
      child.send({
        type: 'shutdown',
        protocolVersion: PROTOCOL_VERSION,
        id: `shutdown-${randomUUID()}`,
      })
    }
    if (await this.waitForExit(child, SHUTDOWN_GRACE_MS)) return
    child.kill('SIGTERM')
    if (await this.waitForExit(child, TERM_GRACE_MS)) return
    child.kill('SIGKILL')
    await this.waitForExit(child, TERM_GRACE_MS)
  }

  private launch(): void {
    this.resetReady()
    const child = fork(this.options.entry, this.options.args ?? [], {
      execPath: this.options.nodeExecutable,
      execArgv: ['--expose-internals'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.on('message', (frame: RuntimeResponseFrame) => {
      if (frame.type === 'ready') this.resolveReady()
      if (frame.type === 'office:bound') {
        const pending = this.pendingBindings.get(frame.id)
        if (pending !== undefined) {
          this.pendingBindings.delete(frame.id)
          pending.resolve({ sessionId: frame.sessionId, resumed: frame.resumed })
        }
      }
      if (frame.type === 'agent:event' && frame.event.type === 'turn/end') {
        this.activeSessions.delete(frame.sessionId)
      }
      for (const listener of this.frames) listener(frame)
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      const activeSessions = [...this.activeSessions]
      this.activeSessions.clear()
      for (const pending of this.pendingBindings.values()) {
        pending.reject(new Error(`Harness runtime exited during Office Session binding (${String(code ?? signal)})`))
      }
      this.pendingBindings.clear()
      for (const listener of this.exits) listener({ code, signal, activeSessions })
      if (!this.stopping) {
        this.restartTimer = setTimeout(() => this.launch(), this.options.restartDelayMs ?? 1_000)
      }
    })
  }

  private resetReady(): void {
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  private send(frame: RuntimeRequestFrame): void {
    if (this.child?.connected !== true) throw new Error('Harness runtime is not connected')
    this.child.send(frame)
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }
}
