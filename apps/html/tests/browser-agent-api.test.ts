import { describe, expect, it, vi } from 'vitest'
import type { ClientId, EditorRequestFrame } from '@nexusdesk/protocol'
import type { NexusClient, NexusClientState } from '@nexusdesk/web-client'

import { createHtmlBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'

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

describe('HTML browser Agent bridge', () => {
  it('rejects missing, unrelated, and legacy constant save approvals without a proposal', async () => {
    const client = new FakeClient()
    const bridge = createHtmlBrowserAgentBridge({
      client,
      documentId: 'html-1' as never,
      revision: 1 as never,
    })
    const save = vi.fn().mockResolvedValue({ ok: true, summary: 'Saved.', warnings: [] })
    bridge.attachEditor({
      editorType: 'html',
      capabilities: () => ({
        editorType: 'html',
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
      documentId: 'html-1',
      editorType: 'html',
      revision: 1,
      clientId: 'client-1',
    }
    const sendSave = (operationId: string, approval?: { id: string; planHash: string }) =>
      (client.frames.push as never)({
        type: 'editor:request',
        protocolVersion: 1,
        id: `request-${operationId}`,
        target: { ...target, operationId },
        command: 'save_html',
        arguments: { inPlace: true },
        approval,
      })

    sendSave('missing')
    sendSave('wrong', { id: 'approval-wrong', planHash: 'other-plan' })
    sendSave('valid', { id: 'approval-1', planHash: 'save-current-html-in-place' })
    sendSave('replayed', { id: 'approval-1', planHash: 'save-current-html-in-place' })
    await new Promise((resolve) => setTimeout(resolve, 0))

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
  })
})
