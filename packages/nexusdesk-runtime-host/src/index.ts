import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'

import { loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type { ApprovalOutcome, SessionId } from '@nexusdesk/protocol'

import { projectDurableEvent, projectStreamChunk } from './projection'
import {
  PROTOCOL_VERSION,
  type HarnessDurableEvent,
  type HarnessStreamChunk,
  type RuntimeRequestFrame,
  type RuntimeResponseFrame,
} from './protocol'

interface AgentHandle {
  agent: {
    followup(message: unknown): void
    cancel(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
  }
  dispose(): Promise<void>
}

interface RuntimeContext {
  agents: {
    create(options: unknown): Promise<unknown>
  }
  profileContext: {
    startedBundles: unknown
  }
  on(
    event: 'approval/request',
    listener: (request: {
      toolName: string
      reason?: string
      agent?: { session?: { id?: unknown } }
    }) => Promise<ApprovalOutcome>,
  ): void
  on(
    event: 'session/event',
    listener: (session: { id: unknown }, event: HarnessDurableEvent) => void,
  ): void
  on(
    event: 'agent/assistant-stream',
    listener: (payload: {
      agent: { session: { id: string } }
      frame: { chunk?: HarnessStreamChunk }
    }) => void,
  ): void
}

function asRuntimeContext(value: unknown): RuntimeContext {
  return value as RuntimeContext
}

const [runtimeDir = '', profileDir = '', mode = 'runtime', ...patchFiles] = process.argv.slice(2)
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

function send(frame: RuntimeResponseFrame): void {
  if (!process.connected || process.send === undefined) return
  process.send(frame, (error) => {
    if (error !== null) process.stderr.write(`[runtime-host] IPC send failed: ${error.message}\n`)
  })
}

const replies = new Map<string, (frame: RuntimeRequestFrame) => void>()
const agents = new Map<string, AgentHandle>()
const textBlocks = new Map<string, Set<number>>()
let stopping: Promise<void> | undefined

process.on('message', (frame: RuntimeRequestFrame) => {
  if (frame.protocolVersion !== PROTOCOL_VERSION && frame.type !== 'shutdown') {
    send({ type: 'fatal', protocolVersion: PROTOCOL_VERSION, message: 'runtime protocol version mismatch' })
    process.exitCode = 1
    return
  }
  if (frame.type === 'approval:response' || frame.type === 'editor:result') {
    replies.get(frame.id)?.(frame)
    replies.delete(frame.id)
    return
  }
  void handle(frame).catch((error: unknown) => {
    send({
      type: 'fatal',
      protocolVersion: PROTOCOL_VERSION,
      message: error instanceof Error ? error.message : String(error),
    })
  })
})

function requestParent(
  frame: Omit<Extract<RuntimeResponseFrame, { type: 'approval:request' }>, 'id' | 'protocolVersion'>,
  timeoutMs = 120_000,
): Promise<RuntimeRequestFrame> {
  const id = `approval-${randomUUID()}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      replies.delete(id)
      reject(new Error(`approval request timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    replies.set(id, (reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
    send({ ...frame, type: 'approval:request', protocolVersion: PROTOCOL_VERSION, id })
  })
}

const boot = runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: basename(profileDir),
  resolutionMode: mode === 'link' ? 'link' : 'runtime',
  resolvedProfile: {
    profile: loadProfileDirectory('dsh', profileDir, installAnchor),
    installAnchor,
  },
  patchFiles,
  args: [],
})

async function openAgent(frame: Extract<RuntimeRequestFrame, { type: 'agent:start' }>): Promise<AgentHandle> {
  const existing = agents.get(frame.sessionId)
  if (existing !== undefined) return existing
  const ctx = asRuntimeContext((await boot).ctx)
  const created = (await ctx.agents.create({
    sessionId: brandString(frame.sessionId),
    meta: { cwd: frame.cwd },
    ...(frame.provider === undefined || frame.model === undefined
      ? {}
      : { agentOptions: { provider: frame.provider, model: frame.model } }),
  })) as AgentHandle
  agents.set(frame.sessionId, created)
  return created
}

async function handle(frame: RuntimeRequestFrame): Promise<void> {
  switch (frame.type) {
    case 'agent:start': {
      const handle = await openAgent(frame)
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: frame.prompt }],
        source: { kind: 'user' },
      }))
      return
    }
    case 'agent:cancel':
      agents.get(frame.sessionId)?.agent.cancel({ kind: 'user' }, { keepInbox: true })
      return
    case 'shutdown':
      await stop()
      return
    case 'approval:response':
    case 'editor:result':
      return
  }
}

const stop = (): Promise<void> => (stopping ??= (async () => {
  const running = await boot.catch(() => undefined)
  for (const handle of agents.values()) await handle.dispose().catch(() => undefined)
  agents.clear()
  await running?.shutdown.shutdown(0)
  send({ type: 'shutdown-complete', protocolVersion: PROTOCOL_VERSION })
  if (process.connected) process.disconnect()
})())

process.once('disconnect', () => { void stop() })

const ctx = asRuntimeContext((await boot).ctx)

ctx.on('approval/request', (request: {
  toolName: string
  reason?: string
  agent?: { session?: { id?: unknown } }
}) => {
  const sessionId = String(request.agent?.session?.id ?? agents.keys().next().value ?? '') as SessionId
  return requestParent({
    type: 'approval:request',
    sessionId,
    toolName: request.toolName,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  }).then((reply) => reply.type === 'approval:response'
    ? reply.outcome
    : 'unavailable') as Promise<ApprovalOutcome>
})

ctx.on('session/event', (session: { id: unknown }, event: HarnessDurableEvent) => {
  send(projectDurableEvent(String(session.id), event))
})

ctx.on('agent/assistant-stream', (payload: {
  agent: { session: { id: string } }
  frame: { chunk?: HarnessStreamChunk }
}) => {
  const chunk = payload.frame.chunk
  if (chunk === undefined) return
  const open = textBlocks.get(payload.agent.session.id) ?? new Set<number>()
  textBlocks.set(payload.agent.session.id, open)
  const projected = projectStreamChunk(payload.agent.session.id, chunk, open)
  if (projected !== undefined) send(projected)
})

send({
  type: 'ready',
  protocolVersion: PROTOCOL_VERSION,
  pid: process.pid,
  startedBundles: ctx.profileContext.startedBundles as string[],
})
