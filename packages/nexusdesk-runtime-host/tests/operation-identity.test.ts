import { rmSync } from 'node:fs'
import type { EventEmitter } from 'node:events'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { RuntimeRequestFrame, RuntimeResponseFrame } from '../src/protocol'

const harness = vi.hoisted(() => ({ tools: [] as ToolDefinition[] }))
vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadLayeredEnv: () => ({}),
  loadProfileDirectory: () => ({}),
}))
vi.mock('@deepseek-ai/dsh/profile-boot', () => ({
  runProfile: async () => ({
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      agents: { create: async () => ({ agent: { followup() {}, cancel() {} }, dispose: async () => {} }) },
      profileContext: { startedBundles: [] },
      tools: { register: (tool: ToolDefinition) => { harness.tools.push(tool); return () => {} } },
      on() {},
    },
    shutdown: { shutdown: async () => {} },
  }),
}))

const sent: RuntimeResponseFrame[] = []
const previousListeners = new Map<string, ReturnType<EventEmitter['listeners']>>()
let runtimeStateDir: string | undefined
const originalDshHome = process.env.DSH_HOME

function receive(frame: RuntimeRequestFrame): void {
  process.emit('message', frame, undefined)
}

beforeAll(async () => {
  for (const event of ['message', 'disconnect', 'exit']) {
    previousListeners.set(event, (process as EventEmitter).listeners(event))
  }
  vi.stubGlobal('process', Object.assign(Object.create(process), {
    connected: true,
    send(frame: RuntimeResponseFrame, callback: (error: Error | null) => void) {
      sent.push(frame)
      callback(null)
      if (frame.type === 'editor:request') {
        queueMicrotask(() => receive({
          type: 'editor:result', protocolVersion: 1, id: frame.id,
          target: frame.target, currentRevision: frame.target.revision,
          result: {
            ok: true, summary: 'Completed.', warnings: [],
            ...(frame.command === 'propose_ops' ? { data: {
              operationId: frame.target.operationId, planHash: 'plan', targets: [],
            } } : {}),
          },
        }))
      } else if (frame.type === 'approval:request') {
        queueMicrotask(() => receive({
          type: 'approval:response', protocolVersion: 1, id: frame.id, outcome: 'allowed-once',
        }))
      }
      return true
    },
  }))
  await import('../src/index')
  runtimeStateDir = process.env.DSH_HOME
})

afterAll(() => {
  for (const [event, original] of previousListeners) {
    for (const listener of (process as EventEmitter).listeners(event)) {
      if (!original.includes(listener)) process.removeListener(event, listener as (...args: unknown[]) => void)
    }
  }
  if (runtimeStateDir !== undefined) rmSync(runtimeStateDir, { recursive: true, force: true })
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  vi.unstubAllGlobals()
})

async function invoke(documentId: string, sessionId: string, toolName = 'read_document') {
  receive({
    type: 'agent:start', protocolVersion: 1, documentId, sessionId,
    clientId: `client-${sessionId}`, editorType: 'docs', revision: 1,
    cwd: '/tmp', prompt: 'test',
  } as RuntimeRequestFrame)
  const tool = harness.tools.find(({ name }) => name === toolName)!
  const start = sent.length
  await tool.execute(toolName === 'read_document' ? { scope: 'document' } : { operations: [] }, {
    agent: { id: sessionId }, callId: 'provider-call-1', name: toolName,
    signal: new AbortController().signal,
  } as never)
  return sent.slice(start).filter((frame) => frame.type === 'editor:request')
}

describe('native Harness operation identity', () => {
  it('separates the same provider call id in different documents', async () => {
    const [first] = await invoke('document-a', 'session-a')
    const [second] = await invoke('document-b', 'session-b')

    expect(first!.target.operationId).not.toBe(second!.target.operationId)
  })

  it('keeps an invocation stable after reconnect with a new session and client', async () => {
    const [, first] = await invoke('document-a', 'session-before', 'apply_document_operations')
    const [, retry] = await invoke('document-a', 'session-after', 'apply_document_operations')

    expect(retry!.target.operationId).toBe(first!.target.operationId)
  })

  it('separates different tools and preserves proposal identity for the approved mutation', async () => {
    const [read] = await invoke('document-a', 'session-read')
    const [proposal, mutation] = await invoke('document-a', 'session-mutate', 'apply_document_operations')

    expect(proposal!.target.operationId).not.toBe(read!.target.operationId)
    expect(mutation!.command).toBe('apply_ops')
    expect(mutation!.target.operationId).toBe(proposal!.target.operationId)
  })
})
