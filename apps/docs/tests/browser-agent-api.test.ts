import { describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  type AgentServerFrame,
  type ClientFrame,
  type ClientId,
  type DocumentId,
  type EditorAdapter,
  type OperationId,
  type RequestId,
  type Revision,
  type SessionId,
} from '@nexusdesk/protocol'
import type { NexusClient, NexusClientState } from '@nexusdesk/web-client'

import { createDocsBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'

class FakeClient implements NexusClient {
  state: NexusClientState = 'ready'
  clientId = 'client-1' as ClientId
  readonly sent: ClientFrame[] = []
  private readonly listeners = new Set<(frame: AgentServerFrame) => void>()

  connect() {}
  close() {}
  send(frame: ClientFrame) {
    this.sent.push(frame)
  }
  request(): Promise<AgentServerFrame> {
    throw new Error('not used')
  }
  onFrame(listener: (frame: AgentServerFrame) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onState() {
    return () => undefined
  }
  emit(frame: AgentServerFrame) {
    for (const listener of this.listeners) listener(frame)
  }
}

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

const documentId = 'document-1' as DocumentId
const revision = 1 as Revision

function adapterWith(overrides: Partial<EditorAdapter> = {}): EditorAdapter {
  return {
    editorType: 'docs',
    capabilities: () => ({
      editorType: 'docs',
      commands: ['read_document', 'apply_ops', 'save_document'],
      canUndo: true,
      canSave: true,
      canExport: false,
    }),
    snapshot: vi.fn(),
    read: vi.fn().mockResolvedValue({ ok: true, summary: 'read', warnings: [], data: {} }),
    propose: vi.fn().mockResolvedValue({
      target: target(),
      planId: 'plan-1',
      planHash: 'exact-plan-hash',
      summary: 'Apply one document operation.',
      operations: [{ op: 'findReplace', find: 'a', replace: 'b' }],
      warnings: [],
    }),
    apply: vi.fn().mockResolvedValue({ ok: true, summary: 'applied', warnings: [] }),
    verify: vi.fn().mockResolvedValue({ passed: true, issues: [] }),
    undo: vi.fn(),
    save: vi.fn().mockResolvedValue({ ok: true, summary: 'saved', warnings: [] }),
    export: vi.fn(),
    ...overrides,
  }
}

function target() {
  return {
    sessionId: 'session-1' as SessionId,
    documentId,
    editorType: 'docs',
    revision,
    operationId: 'operation-1' as OperationId,
    clientId: 'client-1' as ClientId,
  }
}

function request(command: string, approval?: { id: RequestId; planHash: string }) {
  return {
    type: 'editor:request' as const,
    protocolVersion: PROTOCOL_VERSION,
    id: `${command}-request` as RequestId,
    target: target(),
    command,
    arguments: { ops: [{ op: 'findReplace', find: 'a', replace: 'b' }] },
    ...(approval === undefined ? {} : { approval }),
  }
}

describe('Docs browser Agent bridge', () => {
  it('requires a matching proposal and delivers only the Agent result envelope', async () => {
    const client = new FakeClient()
    const adapter = adapterWith()
    const bridge = createDocsBrowserAgentBridge({
      client,
      documentId,
      revision,
      storage: new MemoryStorage(),
    })
    bridge.attachEditor(adapter)

    client.emit(request('propose_ops'))
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(1),
    )
    client.emit(
      request('apply_ops', {
        id: 'approval-1' as RequestId,
        planHash: 'exact-plan-hash',
      }),
    )
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(2),
    )

    expect(adapter.apply).toHaveBeenCalledWith(
      expect.objectContaining({ planHash: 'exact-plan-hash', approvalId: 'approval-1' }),
    )
    expect(client.sent.at(-1)).toMatchObject({
      type: 'editor:result',
      result: { ok: true, summary: 'applied', warnings: [] },
    })
    bridge.dispose()
  })

  it('replays a journaled result without applying the document operation again', async () => {
    const client = new FakeClient()
    const storage = new MemoryStorage()
    const apply = vi.fn().mockResolvedValue({ ok: true, summary: 'applied once', warnings: [] })
    const bridge = createDocsBrowserAgentBridge({ client, documentId, revision, storage })
    bridge.attachEditor(adapterWith({ apply }))
    const propose = request('propose_ops')
    const applyFrame = request('apply_ops', {
      id: 'approval-1' as RequestId,
      planHash: 'exact-plan-hash',
    })

    client.emit(propose)
    await vi.waitFor(() => expect(client.sent).toHaveLength(2))
    client.emit(applyFrame)
    await vi.waitFor(() => expect(client.sent).toHaveLength(3))
    client.emit({ ...applyFrame, id: 'apply-retry' as RequestId })
    await vi.waitFor(() => expect(client.sent).toHaveLength(4))

    expect(apply).toHaveBeenCalledTimes(1)
    const results = client.sent.filter((frame) => frame.type === 'editor:result')
    expect(results.at(-1)).toMatchObject({ result: { ok: true, summary: 'applied once' } })
    expect(results.at(-1)?.type === 'editor:result' && results.at(-2)?.type === 'editor:result'
      ? results.at(-1)?.result
      : undefined).toEqual(results.at(-2)?.type === 'editor:result' ? results.at(-2)?.result : undefined)
    bridge.dispose()
  })

  it('detaches the live editor without disposing the Host connection', async () => {
    const client = new FakeClient()
    const adapter = adapterWith()
    const bridge = createDocsBrowserAgentBridge({
      client,
      documentId,
      revision,
      storage: new MemoryStorage(),
    })
    const detach = bridge.attachEditor(adapter)

    detach()
    client.emit(request('read_document'))
    await vi.waitFor(() =>
      expect(client.sent.some((frame) => frame.type === 'editor:result')).toBe(true),
    )

    expect(adapter.read).not.toHaveBeenCalled()
    expect(client.sent.at(-1)).toMatchObject({
      result: { ok: false, warnings: [{ code: 'EDITOR_NOT_READY' }] },
    })
    bridge.dispose()
  })
})
