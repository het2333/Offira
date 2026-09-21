import { mkdtempSync, rmSync } from 'node:fs'
import type { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { RuntimeRequestFrame, RuntimeResponseFrame } from '../src/protocol'

const harness = vi.hoisted(() => ({
  tools: [] as ToolDefinition[],
  creates: [] as unknown[],
  resumes: [] as unknown[],
  followups: [] as unknown[],
  createBarrier: undefined as Promise<void> | undefined,
  approvalListener: undefined as
    | ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>)
    | undefined,
}))
vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadLayeredEnv: () => ({}),
  loadProfileDirectory: () => ({}),
}))
vi.mock('@deepseek-ai/dsh/profile-boot', () => ({
  runProfile: async () => ({
    ctx: {
      clientModules: {
        graph: () => ({ entries: [] }),
        fetchBundle: async () => new Response(null, { status: 404 }),
      },
      connection: {
        createSharedFetchHandler: () => ({
          fetch: async () => new Response(null, { status: 404 }),
        }),
      },
      typertGateway: {
        wireStream: {
          async *open() {},
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      agents: {
        create: async (options: unknown) => {
          harness.creates.push(options)
          await harness.createBarrier
          return {
            agent: {
              inbox: { hasPending: false, clear() {} },
              followup(message: unknown) { harness.followups.push(message) },
              cancel() {},
            },
            dispose: async () => {},
          }
        },
        resume: async (options: unknown) => {
          harness.resumes.push(options)
          return {
            agent: {
              inbox: { hasPending: false, clear() {} },
              followup(message: unknown) { harness.followups.push(message) },
              cancel() {},
            },
            dispose: async () => {},
          }
        },
      },
      sessionPersistence: { stat: async () => undefined },
      profileContext: { startedBundles: [] },
      tools: { register: (tool: ToolDefinition) => { harness.tools.push(tool); return () => {} } },
      on(event: string, listener: (request: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
        if (event === 'approval/request') harness.approvalListener = listener
      },
    },
    shutdown: { shutdown: async () => {} },
  }),
}))

const sent: RuntimeResponseFrame[] = []
const previousListeners = new Map<string, ReturnType<EventEmitter['listeners']>>()
let runtimeStateDir: string | undefined
const originalDshHome = process.env.DSH_HOME
const originalArgv = [...process.argv]

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
  const explicitStateDirectory = mkdtempSync(join(tmpdir(), 'nexusdesk-explicit-runtime-test-'))
  process.argv.splice(2, process.argv.length - 2, '/runtime', '/profile', 'runtime', `--state-dir=${explicitStateDirectory}`)
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
  process.argv.splice(0, process.argv.length, ...originalArgv)
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
  it('uses an explicit durable state directory without installing a deletion exit hook', () => {
    expect(runtimeStateDir).toMatch(/nexusdesk-explicit-runtime-test-/)
    expect((process as EventEmitter).listeners('exit')).toEqual(previousListeners.get('exit'))
  })

  it('binds an official Office Session without submitting a prompt', async () => {
    const sentBefore = sent.length
    const followupsBefore = harness.followups.length
    receive({
      type: 'office:bind', protocolVersion: 1, id: 'bind-1', hostId: 'host-a',
      documentId: 'native-document' as never, clientId: 'native-client' as never,
      editorType: 'docs', revision: 4 as never, cwd: '/workspace',
    })

    await vi.waitFor(() => {
      expect(sent.slice(sentBefore)).toContainEqual(expect.objectContaining({
        type: 'office:bound', id: 'bind-1', resumed: false,
      }))
    })
    const bound = sent.slice(sentBefore).find((frame) => frame.type === 'office:bound')
    expect(bound?.sessionId).toMatch(/^office-/)
    expect(harness.creates.at(-1)).toEqual(expect.objectContaining({
      sessionId: bound?.sessionId,
      meta: { cwd: '/workspace' },
    }))
    expect(harness.followups).toHaveLength(followupsBefore)
  })

  it('coalesces concurrent binds for the same Host and document', async () => {
    let release!: () => void
    harness.createBarrier = new Promise<void>((resolve) => { release = resolve })
    const sentBefore = sent.length
    const createsBefore = harness.creates.length
    for (const id of ['bind-concurrent-1', 'bind-concurrent-2']) {
      receive({
        type: 'office:bind', protocolVersion: 1, id, hostId: 'host-a',
        documentId: 'concurrent-document' as never, clientId: 'native-client' as never,
        editorType: 'docs', revision: 4 as never, cwd: '/workspace',
      })
    }

    await vi.waitFor(() => expect(harness.creates.length).toBeGreaterThan(createsBefore))
    expect(harness.creates).toHaveLength(createsBefore + 1)
    release()
    harness.createBarrier = undefined
    await vi.waitFor(() => {
      expect(sent.slice(sentBefore).filter((frame) => frame.type === 'office:bound')).toHaveLength(2)
    })
    const bindings = sent.slice(sentBefore).filter((frame) => frame.type === 'office:bound')
    expect(new Set(bindings.map((frame) => frame.sessionId))).toHaveLength(1)
  })

  it('delegates generic approvals for official Office Sessions', async () => {
    const sentBeforeBind = sent.length
    receive({
      type: 'office:bind', protocolVersion: 1, id: 'bind-approval', hostId: 'host-a',
      documentId: 'approval-document' as never, clientId: 'native-client' as never,
      editorType: 'docs', revision: 4 as never, cwd: '/workspace',
    })
    await vi.waitFor(() => {
      expect(sent.slice(sentBeforeBind)).toContainEqual(expect.objectContaining({
        type: 'office:bound', id: 'bind-approval',
      }))
    })
    const bound = sent.slice(sentBeforeBind).find(
      (frame): frame is Extract<RuntimeResponseFrame, { type: 'office:bound' }> =>
        frame.type === 'office:bound' && frame.id === 'bind-approval',
    )
    const next = vi.fn(async () => 'rejected')
    const sentBeforeApproval = sent.length

    await expect(harness.approvalListener!(
      { toolName: 'bash', agent: { session: { id: bound!.sessionId } } },
      next,
    )).resolves.toBe('rejected')

    expect(next).toHaveBeenCalledOnce()
    expect(sent.slice(sentBeforeApproval)).not.toContainEqual(expect.objectContaining({
      type: 'approval:request',
    }))
  })

  it('keeps generic approvals for legacy sessions on parent IPC', async () => {
    const next = vi.fn(async () => 'rejected')
    const sentBeforeApproval = sent.length

    await expect(harness.approvalListener!(
      {
        toolName: 'bash',
        reason: 'needs shell access',
        agent: { session: { id: 'legacy-session' } },
      },
      next,
    )).resolves.toBe('allowed-once')

    expect(next).not.toHaveBeenCalled()
    expect(sent.slice(sentBeforeApproval)).toContainEqual(expect.objectContaining({
      type: 'approval:request',
      sessionId: 'legacy-session',
      toolName: 'bash',
      reason: 'needs shell access',
    }))
  })

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
