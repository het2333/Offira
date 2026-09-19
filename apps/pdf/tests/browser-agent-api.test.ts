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
  it('requires an exact proposal and applies it only while its approval is live', async () => {
    const client = new FakeClient()
    const adapter: PdfEditorAdapter = {
      read: vi.fn().mockResolvedValue({ ok: true, summary: 'read', warnings: [] }),
      snapshot: vi.fn().mockResolvedValue('snapshot-1'),
      propose: vi
        .fn()
        .mockResolvedValue({
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
      propose: vi
        .fn()
        .mockResolvedValue({
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
})
