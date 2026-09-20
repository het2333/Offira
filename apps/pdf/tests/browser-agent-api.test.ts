import { describe, expect, it, vi } from 'vitest'

import {
  PROTOCOL_VERSION,
  type AgentServerFrame,
  type ClientFrame,
  type ClientId,
  type DocumentId,
  type EditorRequestFrame,
  type RequestId,
  type Revision,
} from '@nexusdesk/protocol'
import type { NexusClient, NexusClientState } from '@nexusdesk/web-client'

import {
  createPdfBrowserAgentBridge,
  type PdfEditorAdapter,
} from '../src/renderer/agent/browser-agent-api'

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

function request(
  command: string,
  approval?: { id: RequestId; planHash: string },
  operationId = 'operation-1',
): EditorRequestFrame {
  return {
    type: 'editor:request',
    protocolVersion: PROTOCOL_VERSION,
    id: `${command}-request` as RequestId,
    target: {
      sessionId: 'session-1' as never,
      documentId: 'pdf-1' as DocumentId,
      editorType: 'pdf',
      revision: 1 as Revision,
      operationId: operationId as never,
      clientId: 'client-1' as ClientId,
    },
    command,
    arguments: { ops: [{ op: 'rotatePages', pages: [1], dir: 90 }] },
    ...(approval === undefined ? {} : { approval }),
  }
}

describe('PDF browser Agent bridge', () => {
  it('keeps the adapter that verified the proposal when React replaces its adapter during the await', async () => {
    const client = new FakeClient()
    let snapshots = 0
    let release!: (value: string) => void
    const adapter: PdfEditorAdapter = {
      read: vi.fn(),
      propose: async () => ({ planHash: 'plan', summary: 'Mark', targets: [] }),
      proposeSave: vi.fn(),
      save: vi.fn(),
      snapshot: async () =>
        ++snapshots === 1
          ? 'same'
          : new Promise((resolve) => {
              release = resolve
            }),
      apply: async () => ({ ok: true, summary: 'verified adapter', warnings: [] }),
    }
    const bridge = createPdfBrowserAgentBridge({
      client,
      documentId: 'pdf-1' as DocumentId,
      revision: 1 as Revision,
    })
    bridge.attachEditor(adapter)
    client.emit(request('propose_ops'))
    await vi.waitFor(() =>
      expect(client.sent.filter((f) => f.type === 'editor:result')).toHaveLength(1),
    )
    client.emit(request('apply_ops', { id: 'approval' as RequestId, planHash: 'plan' }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    bridge.attachEditor({
      ...adapter,
      apply: async () => ({ ok: true, summary: 'unverified replacement', warnings: [] }),
    })
    release('same')
    await vi.waitFor(() =>
      expect(client.sent.filter((f) => f.type === 'editor:result')).toHaveLength(2),
    )
    expect(client.sent.at(-1)).toMatchObject({ result: { summary: 'verified adapter' } })
    bridge.dispose()
  })
  it('returns the durable save result when lookup recovers an uncertain save but reload fails', async () => {
    const client = new FakeClient()
    const state = {
      documentEpoch: 'epoch',
      workingRevision: 1,
      savedRevision: 1,
      sourceContentId: 'a'.repeat(64),
      checkpointId: null,
      dirty: false,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    }
    let committed = false
    let applications = 0
    const receipt = {
      documentEpoch: 'epoch',
      operationId: 'save',
      requestFingerprint: 'f'.repeat(64),
      checkpointId: 'checkpoint',
      blobHash: 'b'.repeat(64),
      workingRevision: 2,
      savedRevision: 2,
      dirty: false,
    }
    const bridge = createPdfBrowserAgentBridge({
      client,
      documentId: 'pdf-1' as DocumentId,
      revision: 1 as Revision,
      workingCopy: {
        state: () => state,
        persistence: {
          lookup: async () =>
            committed
              ? {
                  state: 'committed',
                  result: { ok: true, summary: 'Saved', warnings: [] },
                  persistence: receipt,
                }
              : { state: 'not-found' },
          checkpoint: async () => {
            throw Object.assign(Error('lost'), { code: 'WORKING_COPY_OUTCOME_UNKNOWN' })
          },
        },
      },
    })
    bridge.attachEditor({
      read: vi.fn(),
      snapshot: async () => 'snapshot',
      propose: vi.fn(),
      apply: vi.fn(),
      proposeSave: async () => ({
        planHash: 'plan',
        snapshotHash: 'snapshot',
        summary: 'Save',
        targets: [],
      }),
      save: async () => {
        applications++
        return {
          ok: true,
          summary: 'Saved',
          warnings: [],
          workingCopy: { kind: 'pdf-save-plan', parts: new Map() },
        }
      },
      persisted: async () => {
        throw Error('PDF decode failed')
      },
    })
    client.emit(request('propose_save', undefined, 'save'))
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(1),
    )
    const save = request('save_pdf', { id: 'approval' as RequestId, planHash: 'plan' }, 'save')
    client.emit(save)
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(2),
    )
    committed = true
    client.emit(save)
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(3),
    )
    expect(client.sent.at(-1)).toMatchObject({
      result: { ok: true, summary: 'Saved', warnings: [{ code: 'PDF_RELOAD_FAILED' }] },
      persistence: { dirty: false },
    })
    expect(applications).toBe(1)
    bridge.dispose()
  })
  it('blocks later mutations while a checkpoint outcome is unknown and never reapplies an uncertain operation', async () => {
    const client = new FakeClient()
    const state = {
      documentEpoch: 'epoch',
      workingRevision: 1,
      savedRevision: 1,
      sourceContentId: 'a'.repeat(64),
      checkpointId: null,
      dirty: false,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    }
    let applications = 0
    const bridge = createPdfBrowserAgentBridge({
      client,
      documentId: 'pdf-1' as DocumentId,
      revision: 1 as Revision,
      workingCopy: {
        state: () => state,
        persistence: {
          lookup: async () => ({ state: 'not-found' }),
          checkpoint: async () => {
            throw Object.assign(Error('connection lost'), { code: 'WORKING_COPY_OUTCOME_UNKNOWN' })
          },
        },
      },
    })
    bridge.attachEditor({
      read: vi.fn(),
      snapshot: async () => 'same',
      propose: async () => ({ planHash: 'plan', summary: 'Mark', targets: [] }),
      proposeSave: vi.fn(),
      save: vi.fn(),
      apply: async () => {
        applications++
        return {
          ok: true,
          summary: 'applied',
          warnings: [],
          workingCopy: { kind: 'pdf-save-plan', parts: new Map() },
        }
      },
    })
    for (const operationId of ['one', 'two']) {
      client.emit(request('propose_ops', undefined, operationId))
      await vi.waitFor(() =>
        expect(
          client.sent.filter(
            (f) => f.type === 'editor:result' && f.target.operationId === operationId,
          ),
        ).toHaveLength(1),
      )
      client.emit(
        request('apply_ops', { id: 'approval' as RequestId, planHash: 'plan' }, operationId),
      )
      await vi.waitFor(() =>
        expect(
          client.sent.filter(
            (f) => f.type === 'editor:result' && f.target.operationId === operationId,
          ),
        ).toHaveLength(2),
      )
    }
    expect(applications).toBe(1)
    expect(client.sent.at(-1)).toMatchObject({
      result: { ok: false, warnings: [{ code: 'WORKING_COPY_OUTCOME_UNKNOWN' }] },
    })
    client.emit(request('apply_ops', { id: 'approval' as RequestId, planHash: 'plan' }, 'one'))
    await vi.waitFor(() =>
      expect(client.sent.filter((f) => f.type === 'editor:result')).toHaveLength(5),
    )
    expect(applications).toBe(1)
    bridge.dispose()
  })
  it('waits for the captured post-state checkpoint before ok and ignores throwing storage', async () => {
    const client = new FakeClient()
    const state = {
      documentEpoch: 'epoch',
      workingRevision: 1,
      savedRevision: 1,
      sourceContentId: 'a'.repeat(64),
      checkpointId: null,
      dirty: false,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    }
    const payload = {
      kind: 'pdf-save-plan' as const,
      parts: new Map([['manifest', new Blob(['captured'])]]),
    }
    let finish!: (value: unknown) => void
    let received: unknown
    const persistence = {
      lookup: async () => ({ state: 'not-found' as const }),
      checkpoint: async (_frame: unknown, _result: unknown, capture: unknown) => {
        received = capture
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    }
    let applications = 0
    const adapter: PdfEditorAdapter = {
      read: vi.fn(),
      snapshot: async () => 'snapshot',
      propose: async () => ({ planHash: 'plan', summary: 'Mark', targets: ['page:1'] }),
      proposeSave: vi.fn(),
      save: vi.fn(),
      apply: async () => {
        applications++
        return { ok: true, summary: 'Applied', warnings: [], workingCopy: payload }
      },
    }
    const storage = {
      getItem: () => {
        throw Error('disabled')
      },
      setItem: () => {
        throw Error('disabled')
      },
      removeItem: () => {
        throw Error('disabled')
      },
    }
    const bridge = createPdfBrowserAgentBridge({
      client,
      documentId: 'pdf-1' as DocumentId,
      revision: 1 as Revision,
      storage,
      workingCopy: {
        state: () => state,
        persistence: persistence as never,
        didPersist: (receipt) => {
          Object.assign(state, {
            workingRevision: receipt.workingRevision,
            checkpointId: receipt.checkpointId,
            dirty: receipt.dirty,
          })
        },
      },
    })
    bridge.attachEditor(adapter)
    client.emit(request('propose_ops'))
    await vi.waitFor(() =>
      expect(client.sent.filter((f) => f.type === 'editor:result')).toHaveLength(1),
    )
    const apply = request('apply_ops', { id: 'approval' as RequestId, planHash: 'plan' })
    expect(() => {
      client.emit(apply)
      client.emit(apply)
    }).not.toThrow()
    await vi.waitFor(() => expect(received).toBe(payload))
    expect(client.sent.filter((f) => f.type === 'editor:result')).toHaveLength(1)
    finish({
      documentEpoch: 'epoch',
      operationId: 'operation-1',
      requestFingerprint: 'f'.repeat(64),
      checkpointId: 'checkpoint',
      blobHash: 'b'.repeat(64),
      workingRevision: 2,
      savedRevision: 1,
      dirty: true,
    })
    await vi.waitFor(() =>
      expect(client.sent.filter((f) => f.type === 'editor:result')).toHaveLength(3),
    )
    expect(applications).toBe(1)
    expect(client.sent.at(-1)).toMatchObject({
      result: { ok: true },
      persistence: { checkpointId: 'checkpoint' },
    })
    expect((client.sent.at(-1) as any).result).not.toHaveProperty('workingCopy')
    expect(client.sent.filter((f) => f.type === 'editor:register').at(-1)).toMatchObject({
      revision: 2,
      sourceContentId: 'a'.repeat(64),
      restoredCheckpointId: 'checkpoint',
    })
    bridge.dispose()
  })
  it('coalesces concurrent page rewrite replay and replays the committed result after reconnect', async () => {
    const client = new FakeClient()
    const entries = new Map<string, string>()
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value)
      },
      removeItem: (key: string) => {
        entries.delete(key)
      },
    }
    let finish: (result: { ok: true; summary: string; warnings: [] }) => void = () => {}
    const adapter: PdfEditorAdapter = {
      read: vi.fn(),
      snapshot: vi.fn().mockResolvedValue('snapshot-1'),
      propose: vi.fn().mockResolvedValue({
        planHash: 'page-plan',
        summary: 'Insert blank page',
        targets: ['current PDF'],
      }),
      proposeSave: vi.fn(),
      save: vi.fn(),
      apply: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    }
    const bridge = createPdfBrowserAgentBridge({
      client,
      storage,
      documentId: 'pdf-1' as DocumentId,
      revision: 1 as Revision,
    })
    bridge.attachEditor(adapter)
    const proposal = request('propose_ops', undefined, 'rewrite-1')
    proposal.arguments = {
      ops: [{ op: 'modify_pdf_pages', action: 'insertBlankPage', afterPage: 1 }],
    }
    client.emit(proposal)
    await vi.waitFor(() =>
      expect(client.sent.filter((f) => f.type === 'editor:result')).toHaveLength(1),
    )
    const apply = request(
      'apply_ops',
      { id: 'approval-1' as RequestId, planHash: 'page-plan' },
      'rewrite-1',
    )
    apply.arguments = {}
    client.emit(apply)
    client.emit(apply)
    await vi.waitFor(() => expect(adapter.apply).toHaveBeenCalledTimes(1))
    finish({ ok: true, summary: 'Inserted once', warnings: [] })
    await vi.waitFor(() =>
      expect(client.sent.filter((f) => f.type === 'editor:result')).toHaveLength(3),
    )
    bridge.dispose()
    const reconnected = createPdfBrowserAgentBridge({
      client,
      storage,
      documentId: 'pdf-1' as DocumentId,
      revision: 2 as Revision,
    })
    reconnected.attachEditor(adapter)
    client.emit(apply)
    await vi.waitFor(() =>
      expect(client.sent.filter((f) => f.type === 'editor:result')).toHaveLength(4),
    )
    expect(adapter.apply).toHaveBeenCalledTimes(1)
    expect(client.sent.at(-1)).toMatchObject({ result: { ok: true, summary: 'Inserted once' } })
    client.emit({ ...apply, approval: { id: 'tampered' as RequestId, planHash: 'another-plan' } })
    await vi.waitFor(() =>
      expect(client.sent.at(-1)).toMatchObject({
        result: { ok: false, warnings: [{ code: 'OPERATION_ID_COLLISION' }] },
      }),
    )
    expect(adapter.apply).toHaveBeenCalledTimes(1)
    reconnected.dispose()
  })
  it('requires an exact proposal and applies it only while its approval is live', async () => {
    const client = new FakeClient()
    const adapter: PdfEditorAdapter = {
      read: vi.fn().mockResolvedValue({ ok: true, summary: 'read', warnings: [] }),
      snapshot: vi.fn().mockResolvedValue('snapshot-1'),
      propose: vi.fn().mockResolvedValue({
        planHash: 'plan-hash',
        summary: 'Rotate page 1.',
        targets: ['page:1'],
      }),
      proposeSave: vi.fn(),
      apply: vi.fn().mockResolvedValue({ ok: true, summary: 'applied', warnings: [] }),
      save: vi.fn().mockResolvedValue({ ok: true, summary: 'saved', warnings: [] }),
    }
    const bridge = createPdfBrowserAgentBridge({
      client,
      documentId: 'pdf-1' as DocumentId,
      revision: 1 as Revision,
    })
    bridge.attachEditor(adapter)

    client.emit(request('propose_ops', undefined, 'operation-stale'))
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(1),
    )
    client.emit(
      request(
        'apply_ops',
        { id: 'approval-1' as RequestId, planHash: 'plan-hash' },
        'operation-stale',
      ),
    )
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(2),
    )

    expect(adapter.apply).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'approval-1', planHash: 'plan-hash' }),
    )
    expect(adapter.propose).toHaveBeenCalledWith(
      [{ op: 'rotatePages', pages: [1], dir: 90 }],
      'snapshot-1',
    )
    expect(client.sent.at(-1)).toMatchObject({
      type: 'editor:result',
      result: { ok: true, summary: 'applied' },
    })
    bridge.dispose()
  })

  it('rejects an approved edit when manual pending work makes its proposal stale', async () => {
    const client = new FakeClient()
    const adapter: PdfEditorAdapter = {
      read: vi.fn(),
      snapshot: vi
        .fn()
        .mockResolvedValueOnce('snapshot-before')
        .mockResolvedValueOnce('snapshot-after'),
      propose: vi.fn().mockResolvedValue({
        planHash: 'plan-hash',
        summary: 'Rotate page 1.',
        targets: ['page:1'],
      }),
      proposeSave: vi.fn(),
      apply: vi.fn(),
      save: vi.fn(),
    }
    const bridge = createPdfBrowserAgentBridge({
      client,
      documentId: 'pdf-1' as DocumentId,
      revision: 1 as Revision,
    })
    bridge.attachEditor(adapter)

    client.emit(request('propose_ops', undefined, 'operation-manual-edit'))
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(1),
    )
    client.emit(
      request(
        'apply_ops',
        { id: 'approval-1' as RequestId, planHash: 'plan-hash' },
        'operation-manual-edit',
      ),
    )
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(2),
    )

    expect(adapter.apply).not.toHaveBeenCalled()
    expect(client.sent.at(-1)).toMatchObject({
      type: 'editor:result',
      result: { ok: false, warnings: [{ code: 'STALE_PLAN' }] },
    })
    bridge.dispose()
  })

  it('rejects a tampered approval hash without applying the proposal', async () => {
    const client = new FakeClient()
    const adapter: PdfEditorAdapter = {
      read: vi.fn(),
      snapshot: vi.fn().mockResolvedValue('snapshot-1'),
      propose: vi.fn().mockResolvedValue({
        planHash: 'plan-hash',
        summary: 'Rotate page 1.',
        targets: ['page:1'],
      }),
      proposeSave: vi.fn(),
      apply: vi.fn(),
      save: vi.fn(),
    }
    const bridge = createPdfBrowserAgentBridge({
      client,
      documentId: 'pdf-1' as DocumentId,
      revision: 1 as Revision,
    })
    bridge.attachEditor(adapter)
    client.emit(request('propose_ops', undefined, 'operation-tampered'))
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(1),
    )
    client.emit(
      request(
        'apply_ops',
        { id: 'approval-1' as RequestId, planHash: 'different-plan' },
        'operation-tampered',
      ),
    )
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(2),
    )
    expect(adapter.apply).not.toHaveBeenCalled()
    expect(client.sent.at(-1)).toMatchObject({
      type: 'editor:result',
      result: { ok: false, warnings: [{ code: 'APPROVAL_INVALID' }] },
    })
    bridge.dispose()
  })
})
