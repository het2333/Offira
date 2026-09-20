import { describe, expect, it, vi } from 'vitest'
import type { ClientId, EditorRequestFrame } from '@nexusdesk/protocol'
import type { NexusClient, NexusClientState } from '@nexusdesk/web-client'

import { createMarkdownBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'

class FakeClient implements NexusClient {
  state: NexusClientState = 'ready'
  clientId = 'client-1' as ClientId
  readonly frames: EditorRequestFrame[] = []
  readonly sent: unknown[] = []
  connect() {}
  close() {}
  send(frame: unknown) {
    this.sent.push(frame)
  }
  request(): never {
    throw new Error('not used')
  }
  onState() {
    return () => undefined
  }
  onFrame(callback: (frame: EditorRequestFrame) => void) {
    this.frames.push = ((frame: EditorRequestFrame) => {
      callback(frame)
      return 0
    }) as never
    return () => undefined
  }
}

describe('Markdown browser Agent bridge', () => {
  it('requires proposal-bound approval before applying and journals an operation result', async () => {
    const client = new FakeClient()
    const storage = new Map<string, string>()
    const bridge = createMarkdownBrowserAgentBridge({
      client,
      documentId: 'markdown-1' as never,
      revision: 1 as never,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    })
    const apply = vi.fn().mockResolvedValue({ ok: true, summary: 'Applied.', warnings: [] })
    bridge.attachEditor({
      editorType: 'markdown',
      capabilities: () => ({
        editorType: 'markdown',
        commands: [],
        canUndo: false,
        canSave: true,
        canExport: false,
      }),
      snapshot: vi.fn(),
      read: vi.fn(),
      propose: vi.fn().mockResolvedValue({
        planHash: 'plan-1',
        summary: 'Apply.',
        warnings: [],
        operations: [{ op: 'replaceText' }],
        target: {},
      }),
      apply,
      verify: vi.fn(),
      undo: vi.fn(),
      save: vi.fn(),
      export: vi.fn(),
    } as never)

    const frame = {
      type: 'editor:request',
      protocolVersion: 1,
      id: 'request-1',
      target: {
        sessionId: 'session-1',
        documentId: 'markdown-1',
        editorType: 'markdown',
        revision: 1,
        operationId: 'operation-1',
        clientId: 'client-1',
      },
      command: 'apply_ops',
      arguments: { ops: [{ op: 'replaceText' }] },
      approval: { id: 'approval-1', planHash: 'plan-1' },
    } as never
    // An apply without a proposal must not reach the editor.
    ;(client.frames.push as never)(frame)
    await vi.waitFor(() =>
      expect(
        client.sent.filter((frame) => (frame as { type?: string }).type === 'editor:result'),
      ).toHaveLength(1),
    )
    expect(apply).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('rejects missing, unrelated, and legacy constant save approvals without a proposal', async () => {
    const client = new FakeClient()
    const bridge = createMarkdownBrowserAgentBridge({
      client,
      documentId: 'markdown-1' as never,
      revision: 1 as never,
    })
    const save = vi.fn().mockResolvedValue({ ok: true, summary: 'Saved.', warnings: [] })
    bridge.attachEditor({
      editorType: 'markdown',
      capabilities: () => ({
        editorType: 'markdown',
        commands: [],
        canUndo: false,
        canSave: true,
        canExport: false,
      }),
      snapshot: vi.fn(),
      read: vi.fn(),
      propose: vi.fn(),
      apply: vi.fn(),
      verify: vi.fn(),
      undo: vi.fn(),
      save,
      export: vi.fn(),
    } as never)
    const target = {
      sessionId: 'session-1',
      documentId: 'markdown-1',
      editorType: 'markdown',
      revision: 1,
      clientId: 'client-1',
    }
    const sendSave = (operationId: string, approval?: { id: string; planHash: string }) =>
      (client.frames.push as never)({
        type: 'editor:request',
        protocolVersion: 1,
        id: `request-${operationId}`,
        target: { ...target, operationId },
        command: 'save_markdown',
        arguments: { inPlace: true },
        approval,
      })

    sendSave('missing')
    sendSave('wrong', { id: 'approval-wrong', planHash: 'other-plan' })
    sendSave('valid', { id: 'approval-1', planHash: 'save-current-markdown-in-place' })
    sendSave('replayed', { id: 'approval-1', planHash: 'save-current-markdown-in-place' })
    await vi.waitFor(() =>
      expect(
        client.sent.filter((frame) => (frame as { type?: string }).type === 'editor:result'),
      ).toHaveLength(4),
    )

    expect(save).not.toHaveBeenCalled()
    expect(client.sent).toContainEqual(
      expect.objectContaining({
        type: 'editor:result',
        target: expect.objectContaining({ operationId: 'missing' }),
        result: expect.objectContaining({
          ok: false,
          warnings: [expect.objectContaining({ code: 'APPROVAL_INVALID' })],
        }),
      }),
    )
    expect(client.sent).toContainEqual(
      expect.objectContaining({
        type: 'editor:result',
        target: expect.objectContaining({ operationId: 'wrong' }),
        result: expect.objectContaining({
          ok: false,
          warnings: [expect.objectContaining({ code: 'APPROVAL_INVALID' })],
        }),
      }),
    )
    bridge.dispose()
  })
})
