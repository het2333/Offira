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

import { createSlidesBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'

class FakeClient implements NexusClient {
  state: NexusClientState = 'ready'
  clientId = 'client-1' as ClientId
  readonly sent: ClientFrame[] = []
  private readonly listeners = new Set<(frame: AgentServerFrame) => void>()
  connect() {}
  close() {}
  send(frame: ClientFrame) { this.sent.push(frame) }
  request(): Promise<AgentServerFrame> { throw new Error('not used') }
  onFrame(listener: (frame: AgentServerFrame) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  onState() { return () => undefined }
  emit(frame: AgentServerFrame) { for (const listener of this.listeners) listener(frame) }
}

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

const documentId = 'presentation-1' as DocumentId
const revision = 1 as Revision

function target() {
  return { sessionId: 'session-1' as SessionId, documentId, editorType: 'slides' as const, revision, operationId: 'operation-1' as OperationId, clientId: 'client-1' as ClientId }
}

function request(command: string, approval?: { id: RequestId; planHash: string }) {
  return { type: 'editor:request' as const, protocolVersion: PROTOCOL_VERSION, id: `${command}-request` as RequestId, target: target(), command, arguments: { ops: [{ op: 'setText', target: { slide: 0, el: 'title' }, paragraphs: [] }] }, ...(approval === undefined ? {} : { approval }) }
}

function adapterWith(overrides: Partial<EditorAdapter> = {}): EditorAdapter {
  return {
    editorType: 'slides',
    capabilities: () => ({ editorType: 'slides', commands: ['read_presentation', 'apply_ops', 'save_presentation'], canUndo: false, canSave: true, canExport: false }),
    snapshot: vi.fn(),
    read: vi.fn().mockResolvedValue({ ok: true, summary: 'read', warnings: [], data: {} }),
    propose: vi.fn().mockResolvedValue({ target: target(), planId: 'plan-1', planHash: 'exact-plan-hash', summary: 'Apply one presentation operation.', operations: [{ op: 'setText' }], warnings: [] }),
    apply: vi.fn().mockResolvedValue({ ok: true, summary: 'applied', warnings: [] }),
    verify: vi.fn().mockResolvedValue({ passed: true, issues: [] }),
    undo: vi.fn(),
    save: vi.fn().mockResolvedValue({ ok: true, summary: 'saved', warnings: [] }),
    export: vi.fn(),
    ...overrides,
  }
}

describe('Slides browser Agent bridge', () => {
  it('binds an approved presentation transaction to its proposal and replays the result once', async () => {
    const client = new FakeClient()
    const apply = vi.fn().mockResolvedValue({ ok: true, summary: 'applied once', warnings: [] })
    const bridge = createSlidesBrowserAgentBridge({ client, documentId, revision, storage: new MemoryStorage() })
    bridge.attachEditor(adapterWith({ apply }))

    client.emit(request('propose_ops'))
    await vi.waitFor(() => expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(1))
    client.emit(request('apply_ops', { id: 'approval-1' as RequestId, planHash: 'exact-plan-hash' }))
    await vi.waitFor(() => expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(2))
    client.emit({ ...request('apply_ops', { id: 'approval-1' as RequestId, planHash: 'exact-plan-hash' }), id: 'apply-retry' as RequestId })
    await vi.waitFor(() => expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(3))

    expect(apply).toHaveBeenCalledTimes(1)
    expect(client.sent.at(-1)).toMatchObject({ type: 'editor:result', result: { ok: true, summary: 'applied once' } })
    bridge.dispose()
  })

  it('saves only the in-memory presentation version bound by its proposal', async () => {
    const client = new FakeClient()
    const save = vi.fn().mockResolvedValue({ ok: true, summary: 'saved', warnings: [] })
    const bridge = createSlidesBrowserAgentBridge({ client, documentId, revision, storage: new MemoryStorage() })
    const adapter = adapterWith({ save }) as EditorAdapter & {
      proposeSave: ReturnType<typeof vi.fn>
    }
    adapter.proposeSave = vi.fn().mockResolvedValue({
      planHash: 'save-plan-hash',
      contentVersion: 2,
      summary: 'Save the current presentation in place.',
      targets: ['current presentation'],
      warnings: [],
    })
    bridge.attachEditor(adapter)

    client.emit({
      ...request('propose_save'),
      arguments: {},
    })
    await vi.waitFor(() => expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(1))
    expect(client.sent.find((frame) => frame.type === 'editor:result')).toMatchObject({
      type: 'editor:result',
      result: { ok: true, data: { operationId: 'operation-1', planHash: 'save-plan-hash', contentVersion: 2 } },
    })

    client.emit({
      ...request('save_presentation', { id: 'approval-1' as RequestId, planHash: 'save-plan-hash' }),
      arguments: { inPlace: true, contentVersion: 2 },
    })
    await vi.waitFor(() => expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(2))

    expect(save).toHaveBeenCalledWith(documentId, 2)
    bridge.dispose()
  })
})
