import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PROTOCOL_VERSION,
  type AgentServerFrame,
  type ClientId,
  type DocumentId,
  type EditorRequestFrame,
  type OperationId,
  type RequestId,
  type Revision,
  type SessionId,
} from '@nexusdesk/protocol'
import { AgentRouter } from '../src/agent-router'
import { DocumentRegistry } from '../src/document-registry'
import { HarnessSupervisor } from '../src/harness-supervisor'
import { OperationStore } from '../src/operation-store'

const fixture = fileURLToPath(new URL('./fixtures/fake-runtime.mjs', import.meta.url))
const clientId = 'client-1' as ClientId
const documentId = 'document-1' as DocumentId
const sessionId = 'session-1' as SessionId
const revision = 1 as Revision
const startRequestId = 'start-1' as RequestId
const approvalRequestId = 'approval-1' as RequestId
let supervisor: HarnessSupervisor | undefined

afterEach(async () => {
  await supervisor?.shutdown()
  supervisor = undefined
})

describe('AgentRouter', () => {
  it('targets the Harness session with the registered editor type', async () => {
    const documents = new DocumentRegistry()
    documents.register({ documentId, clientId, editorType: 'docs', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const startTurn = vi.spyOn(supervisor, 'startTurn')
    const router = new AgentRouter({
      supervisor,
      documents,
      operations: new OperationStore(),
      sendToClient: vi.fn(),
    })
    await supervisor.ready()

    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: startRequestId,
        sessionId,
        documentId,
        prompt: 'hello',
      },
      clientId,
    )

    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ editorType: 'docs' }))
    router.dispose()
  })

  it('rejects an unapproved native Docs save before it reaches the editor', async () => {
    const documents = new DocumentRegistry()
    documents.register({ documentId, clientId, editorType: 'docs', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({
      supervisor,
      documents,
      operations: new OperationStore(),
      sendToClient: (_clientId, frame) => sent.push(frame),
    })
    await supervisor.ready()

    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: startRequestId,
        sessionId,
        documentId,
        prompt: 'docs-save-unapproved',
      },
      clientId,
    )
    await until(() =>
      sent.some(
        (frame) => frame.type === 'agent:event' && frame.event.type === 'test/editor-result',
      ),
    )

    expect(sent.some((frame) => frame.type === 'editor:request')).toBe(false)
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'agent:event',
        event: expect.objectContaining({
          type: 'test/editor-result',
          data: expect.objectContaining({
            result: expect.objectContaining({
              ok: false,
              warnings: [expect.objectContaining({ code: 'EDITOR_ROUTE_REJECTED' })],
            }),
          }),
        }),
      }),
    )
    router.dispose()
  })

  it('expires a pending approval and sends one terminal failure when runtime crashes', async () => {
    const documents = new DocumentRegistry()
    const operations = new OperationStore()
    const sent: AgentServerFrame[] = []
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const router = new AgentRouter({
      supervisor,
      documents,
      operations,
      sendToClient: (_clientId, frame) => sent.push(frame),
      approvalTimeoutMs: 500,
    })
    await supervisor.ready()

    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: startRequestId,
        sessionId,
        documentId,
        prompt: 'approval-crash',
      },
      clientId,
    )

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fatal frame timed out')), 3_000)
      const interval = setInterval(() => {
        if (!sent.some((frame) => frame.type === 'fatal')) return
        clearTimeout(timeout)
        clearInterval(interval)
        resolve()
      }, 5)
    })

    expect(sent.filter((frame) => frame.type === 'fatal')).toHaveLength(1)
    expect(router.hasApproval('approval-1')).toBe(false)
    expect(operations.lookup('operation-1' as never)).toBeUndefined()
    expect(documents.assertOwner({ documentId, clientId, revision }).revision).toBe(revision)
    router.dispose()
  })

  it('rejects an approval response from a different browser client', async () => {
    const documents = new DocumentRegistry()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({
      supervisor,
      documents,
      operations: new OperationStore(),
      sendToClient: (_clientId, frame) => sent.push(frame),
      approvalTimeoutMs: 10_000,
    })
    await supervisor.ready()
    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: startRequestId,
        sessionId,
        documentId,
        prompt: 'approval-wait',
      },
      clientId,
    )
    await until(() => router.hasApproval('approval-1'))

    expect(() =>
      router.handleClientFrame(
        {
          type: 'approval:response',
          protocolVersion: PROTOCOL_VERSION,
          id: approvalRequestId,
          outcome: 'allowed-once',
        },
        'other-client' as ClientId,
      ),
    ).toThrow(/does not own approval/)
    router.dispose()
  })

  it('rejects an agent start that tries to take over another client session', async () => {
    const otherClientId = 'client-2' as ClientId
    const otherDocumentId = 'document-2' as DocumentId
    const documents = new DocumentRegistry()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    documents.register({
      documentId: otherDocumentId,
      clientId: otherClientId,
      editorType: 'sheets',
      revision,
    })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const router = new AgentRouter({
      supervisor,
      documents,
      operations: new OperationStore(),
      sendToClient: () => undefined,
    })
    await supervisor.ready()
    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: startRequestId,
        sessionId,
        documentId,
        prompt: 'approval-wait',
      },
      clientId,
    )

    expect(() =>
      router.handleClientFrame(
        {
          type: 'agent:start',
          protocolVersion: PROTOCOL_VERSION,
          id: 'start-2' as RequestId,
          sessionId,
          documentId: otherDocumentId,
          prompt: 'hello',
        },
        otherClientId,
      ),
    ).toThrow(/does not own session/)
    router.dispose()
  })

  it('expires a pending approval when the document revision changes', async () => {
    const documents = new DocumentRegistry()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({
      supervisor,
      documents,
      operations: new OperationStore(),
      sendToClient: (_clientId, frame) => sent.push(frame),
      approvalTimeoutMs: 10_000,
    })
    await supervisor.ready()
    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: startRequestId,
        sessionId,
        documentId,
        prompt: 'approval-wait',
      },
      clientId,
    )
    await until(() => router.hasApproval('approval-1'))

    const nextRevision = 2 as Revision
    documents.commitRevision({ documentId, clientId, revision: nextRevision })
    router.handleClientFrame(
      {
        type: 'editor:revision',
        protocolVersion: PROTOCOL_VERSION,
        id: 'revision-1' as RequestId,
        clientId,
        documentId,
        revision: nextRevision,
      },
      clientId,
    )

    await until(() =>
      sent.some(
        (frame) => frame.type === 'agent:event' && frame.event.type === 'test/approval-response',
      ),
    )
    expect(router.hasApproval('approval-1')).toBe(false)
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'agent:event',
        event: expect.objectContaining({
          type: 'test/approval-response',
          data: { id: 'approval-1', outcome: 'unavailable' },
        }),
      }),
    )
    router.dispose()
  })

  it('records an editor result before delivery and serves it after browser reconnect', async () => {
    const documents = new DocumentRegistry()
    const operations = new OperationStore()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: Array<{ clientId: ClientId; frame: AgentServerFrame }> = []
    const router = new AgentRouter({
      supervisor,
      documents,
      operations,
      sendToClient: (targetClientId, frame) => sent.push({ clientId: targetClientId, frame }),
    })
    await supervisor.ready()
    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: startRequestId,
        sessionId,
        documentId,
        prompt: 'editor-wait',
      },
      clientId,
    )
    await until(() => router.hasApproval('editor-approval-1'))
    router.handleClientFrame(
      {
        type: 'approval:response',
        protocolVersion: PROTOCOL_VERSION,
        id: 'editor-approval-1' as RequestId,
        outcome: 'allowed-once',
      },
      clientId,
    )
    await until(() => sent.some(({ frame }) => frame.type === 'editor:request'))
    const request = sent.find(({ frame }) => frame.type === 'editor:request')!
      .frame as EditorRequestFrame
    const result = {
      ok: true,
      summary: 'Updated Summary!B2.',
      changes: { targets: ['Summary!B2'], count: 1 },
      warnings: [],
    }

    expect(() =>
      router.handleClientFrame(
        {
          type: 'editor:result',
          protocolVersion: PROTOCOL_VERSION,
          id: 'wrong-request' as RequestId,
          target: request.target,
          result,
        },
        clientId,
      ),
    ).toThrow(/does not own operation/)
    expect(operations.lookup('operation-1' as OperationId)).toMatchObject({ state: 'reserved' })

    // The browser commits its new revision before returning the result for
    // the operation that was authorized against the previous revision.
    documents.commitRevision({ documentId, clientId, revision: 2 as Revision })
    router.handleClientFrame(
      {
        type: 'editor:result',
        protocolVersion: PROTOCOL_VERSION,
        id: request.id,
        target: request.target,
        result,
      },
      clientId,
    )
    expect(operations.lookup('operation-1' as OperationId)).toMatchObject({
      state: 'committed',
      result,
    })
    await until(() =>
      sent.some(
        ({ frame }) => frame.type === 'agent:event' && frame.event.type === 'test/editor-result',
      ),
    )
    expect(sent).toContainEqual(
      expect.objectContaining({
        frame: expect.objectContaining({
          type: 'agent:event',
          event: expect.objectContaining({
            type: 'test/editor-result',
            data: expect.objectContaining({ currentRevision: 2 }),
          }),
        }),
      }),
    )

    router.disconnectClient(clientId)
    const reconnectedClientId = 'client-reconnected' as ClientId
    documents.register({
      documentId,
      clientId: reconnectedClientId,
      editorType: 'sheets',
      revision: 2 as Revision,
    })
    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: 'start-retry' as RequestId,
        sessionId: 'session-retry' as SessionId,
        documentId,
        prompt: 'editor-wait',
      },
      reconnectedClientId,
    )
    // A committed operation is replayed from the Host journal. The browser
    // must not be asked to approve an operation that cannot execute again.
    await until(
      () =>
        sent.filter(
          ({ frame }) => frame.type === 'agent:event' && frame.event.type === 'test/editor-result',
        ).length === 2,
    )
    expect(router.hasApproval('editor-approval-1')).toBe(false)

    router.handleClientFrame(
      {
        type: 'operation:lookup',
        protocolVersion: PROTOCOL_VERSION,
        id: 'lookup-1' as RequestId,
        operationId: 'operation-1' as OperationId,
      },
      reconnectedClientId,
    )

    expect(sent.filter(({ frame }) => frame.type === 'editor:request')).toHaveLength(1)
    expect(sent.at(-1)).toEqual({
      clientId: reconnectedClientId,
      frame: {
        type: 'operation:result',
        protocolVersion: PROTOCOL_VERSION,
        id: 'lookup-1',
        operationId: 'operation-1',
        result,
      },
    })
    router.dispose()
  })

  it('reissues an uncertain reserved editor request when its document reconnects', async () => {
    const documents = new DocumentRegistry()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: Array<{ clientId: ClientId; frame: AgentServerFrame }> = []
    const router = new AgentRouter({
      supervisor,
      documents,
      operations: new OperationStore(),
      sendToClient: (targetClientId, frame) => sent.push({ clientId: targetClientId, frame }),
    })
    await supervisor.ready()
    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: PROTOCOL_VERSION,
        id: startRequestId,
        sessionId,
        documentId,
        prompt: 'editor-wait',
      },
      clientId,
    )
    await until(() => router.hasApproval('editor-approval-1'))
    router.handleClientFrame(
      {
        type: 'approval:response',
        protocolVersion: PROTOCOL_VERSION,
        id: 'editor-approval-1' as RequestId,
        outcome: 'allowed-once',
      },
      clientId,
    )
    await until(() => sent.some(({ frame }) => frame.type === 'editor:request'))
    const original = sent.find(({ frame }) => frame.type === 'editor:request')!.frame

    router.disconnectClient(clientId)
    documents.detachClient(clientId)
    const reconnectedClientId = 'client-recovered' as ClientId
    documents.register({
      documentId,
      clientId: reconnectedClientId,
      editorType: 'sheets',
      revision: 2 as Revision,
    })
    router.handleClientFrame(
      {
        type: 'editor:register',
        protocolVersion: PROTOCOL_VERSION,
        id: 'register-recovered' as RequestId,
        clientId: reconnectedClientId,
        documentId,
        editorType: 'sheets',
        revision: 2 as Revision,
      },
      reconnectedClientId,
    )

    const replayed = sent.at(-1)
    expect(replayed).toMatchObject({
      clientId: reconnectedClientId,
      frame: {
        type: 'editor:request',
        id: (original as EditorRequestFrame).id,
        target: { clientId: reconnectedClientId },
      },
    })
    expect(() =>
      router.handleClientFrame(
        {
          type: 'editor:result',
          protocolVersion: PROTOCOL_VERSION,
          id: (replayed!.frame as EditorRequestFrame).id,
          target: (replayed!.frame as EditorRequestFrame).target,
          result: { ok: true, summary: 'Recovered without reapplying.', warnings: [] },
        },
        reconnectedClientId,
      ),
    ).not.toThrow()
    router.dispose()
  })
})

async function until(check: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 200; attempts += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}
