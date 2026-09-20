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
  it.each([
    { label: 'document', target: { documentId: 'document-2' as DocumentId } },
    { label: 'editor type', target: { editorType: 'docs' } },
    { label: 'command', command: 'read_document' },
    { label: 'arguments', arguments: { scope: 'selection' } },
  ])('rejects operation replay with a different $label', async (change) => {
    const documents = new DocumentRegistry([
      { documentId, editorType: 'sheets', revision },
      { documentId: 'document-2', editorType: 'sheets', revision },
    ])
    const operations = new OperationStore()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    documents.register({ documentId: 'document-2' as DocumentId, clientId, editorType: 'sheets', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({ supervisor, documents, operations, sendToClient: (_client, frame) => sent.push(frame) })
    await supervisor.ready()
    for (const id of [documentId, 'document-2' as DocumentId]) {
      router.handleClientFrame({
        type: 'agent:start', protocolVersion: PROTOCOL_VERSION, id: startRequestId,
        sessionId: `session-${id}` as SessionId, documentId: id, prompt: 'hello',
      }, clientId)
    }
    const request: EditorRequestFrame = {
      type: 'editor:request', protocolVersion: PROTOCOL_VERSION, id: 'read-1' as RequestId,
      target: {
        documentId, clientId, sessionId: `session-${documentId}` as SessionId,
        editorType: 'sheets', revision, operationId: 'shared-operation' as OperationId,
      },
      command: 'read_sheet', arguments: { scope: 'workbook' },
    }
    router.routeRuntimeFrame(request)
    router.handleClientFrame({
      type: 'editor:result', protocolVersion: PROTOCOL_VERSION, id: request.id,
      target: request.target, result: { ok: true, summary: 'Read first document.', warnings: [] },
    }, clientId)

    const changedDocument = change.target?.documentId ?? documentId
    expect(() => router.routeRuntimeFrame({
      ...request,
      id: 'read-retry' as RequestId,
      target: { ...request.target, ...change.target, sessionId: `session-${changedDocument}` as SessionId },
      command: change.command ?? request.command,
      arguments: change.arguments ?? request.arguments,
    })).toThrow(/different payload/)
    expect(sent.filter((frame) => frame.type === 'editor:request')).toHaveLength(1)
    expect(operations.lookup(request.target.operationId)).toMatchObject({ state: 'committed' })
    router.dispose()
  })

  it('targets the Harness session with the registered editor type', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'docs', revision }])
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
    const documents = new DocumentRegistry([{ documentId, editorType: 'docs', revision }])
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

  it('rejects an unapproved Markdown save before it reaches the editor', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'markdown', revision }])
    documents.register({ documentId, clientId, editorType: 'markdown', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({
      supervisor,
      documents,
      operations: new OperationStore(),
      sendToClient: (_clientId, frame) => sent.push(frame),
    })
    await supervisor.ready()

    router.handleClientFrame({ type: 'agent:start', protocolVersion: PROTOCOL_VERSION, id: startRequestId, sessionId, documentId, prompt: 'markdown-save-unapproved' }, clientId)
    await until(() => sent.some((frame) => frame.type === 'editor:request' || (frame.type === 'agent:event' && frame.event.type === 'test/editor-result')))

    expect(sent.some((frame) => frame.type === 'editor:request')).toBe(false)
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'agent:event',
      event: expect.objectContaining({ type: 'test/editor-result', data: expect.objectContaining({ result: expect.objectContaining({ ok: false, warnings: [expect.objectContaining({ code: 'EDITOR_ROUTE_REJECTED' })] }) }) }),
    }))
    router.dispose()
  })

  it('rejects an HTML save whose approval is for a different plan', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'html', revision }])
    documents.register({ documentId, clientId, editorType: 'html', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({ supervisor, documents, operations: new OperationStore(), sendToClient: (_clientId, frame) => sent.push(frame) })
    await supervisor.ready()

    router.handleClientFrame({ type: 'agent:start', protocolVersion: PROTOCOL_VERSION, id: startRequestId, sessionId, documentId, prompt: 'html-save-wrong-approval' }, clientId)
    await until(() => router.hasApproval('content-save-approval-1'))
    router.handleClientFrame({ type: 'approval:response', protocolVersion: PROTOCOL_VERSION, id: 'content-save-approval-1' as RequestId, outcome: 'allowed-once' }, clientId)
    await until(() => sent.some((frame) => frame.type === 'editor:request' || (frame.type === 'agent:event' && frame.event.type === 'test/editor-result')))

    expect(sent.some((frame) => frame.type === 'editor:request')).toBe(false)
    router.dispose()
  })

  it('consumes a one-time HTML save approval so a replay cannot reach the editor', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'html', revision }])
    documents.register({ documentId, clientId, editorType: 'html', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({ supervisor, documents, operations: new OperationStore(), sendToClient: (_clientId, frame) => sent.push(frame) })
    await supervisor.ready()

    router.handleClientFrame({ type: 'agent:start', protocolVersion: PROTOCOL_VERSION, id: startRequestId, sessionId, documentId, prompt: 'html-save-replayed-approval' }, clientId)
    await until(() => router.hasApproval('content-save-approval-1'))
    router.handleClientFrame({ type: 'approval:response', protocolVersion: PROTOCOL_VERSION, id: 'content-save-approval-1' as RequestId, outcome: 'allowed-once' }, clientId)
    await until(() => sent.filter((frame) => frame.type === 'editor:request').length >= 2 || sent.some((frame) => frame.type === 'agent:event' && frame.event.type === 'test/editor-result'))

    expect(sent.filter((frame) => frame.type === 'editor:request')).toHaveLength(1)
    router.dispose()
  })

  it('rejects an unapproved native Slides save before it reaches the editor', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'slides', revision }])
    documents.register({ documentId, clientId, editorType: 'slides', revision })
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
        prompt: 'slides-save-unapproved',
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

  it('rejects an unapproved Slides history change before it reaches the editor', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'slides', revision }])
    documents.register({ documentId, clientId, editorType: 'slides', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({
      supervisor,
      documents,
      operations: new OperationStore(),
      sendToClient: (_clientId, frame) => sent.push(frame),
    })
    await supervisor.ready()

    router.handleClientFrame({
      type: 'agent:start', protocolVersion: PROTOCOL_VERSION, id: startRequestId,
      sessionId, documentId, prompt: 'slides-history-unapproved',
    }, clientId)
    await until(() => sent.some((frame) => frame.type === 'agent:event' && frame.event.type === 'test/editor-result'))

    expect(sent.some((frame) => frame.type === 'editor:request')).toBe(false)
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'agent:event',
      event: expect.objectContaining({ data: expect.objectContaining({ result: expect.objectContaining({ ok: false, warnings: [expect.objectContaining({ code: 'EDITOR_ROUTE_REJECTED' })] }) }) }),
    }))
    router.dispose()
  })

  it('rejects a Slides save whose approval hash differs from the granted plan', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'slides', revision }])
    documents.register({ documentId, clientId, editorType: 'slides', revision })
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
        prompt: 'slides-save-wrong-plan',
      },
      clientId,
    )
    await until(() => router.hasApproval('slides-save-approval-1'))
    router.handleClientFrame(
      {
        type: 'approval:response',
        protocolVersion: PROTOCOL_VERSION,
        id: 'slides-save-approval-1' as RequestId,
        outcome: 'allowed-once',
      },
      clientId,
    )
    await until(() =>
      sent.some(
        (frame) => frame.type === 'agent:event' && frame.event.type === 'test/editor-result',
      ),
    )

    expect(sent.some((frame) => frame.type === 'editor:request')).toBe(false)
    router.dispose()
  })

  it('consumes a granted Slides save approval exactly once', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'slides', revision }])
    documents.register({ documentId, clientId, editorType: 'slides', revision })
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
        prompt: 'slides-save-reuse-approval',
      },
      clientId,
    )
    await until(() => router.hasApproval('slides-save-approval-1'))
    router.handleClientFrame(
      {
        type: 'approval:response',
        protocolVersion: PROTOCOL_VERSION,
        id: 'slides-save-approval-1' as RequestId,
        outcome: 'allowed-once',
      },
      clientId,
    )
    await until(() =>
      sent.some(
        (frame) => frame.type === 'agent:event' && frame.event.type === 'test/editor-result',
      ),
    )

    expect(sent.filter((frame) => frame.type === 'editor:request')).toHaveLength(1)
    router.dispose()
  })

  it('does not cache a Slides save proposal in place of its approved save', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'slides', revision }])
    const operations = new OperationStore()
    documents.register({ documentId, clientId, editorType: 'slides', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({
      supervisor,
      documents,
      operations,
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
        prompt: 'slides-save-proposal',
      },
      clientId,
    )
    await until(() => sent.some((frame) => frame.type === 'editor:request'))
    const proposal = sent.find((frame) => frame.type === 'editor:request') as EditorRequestFrame
    expect(proposal.command).toBe('propose_save')

    router.handleClientFrame(
      {
        type: 'editor:result',
        protocolVersion: PROTOCOL_VERSION,
        id: proposal.id,
        target: proposal.target,
        result: {
          ok: true,
          summary: 'Save the current presentation in place.',
          warnings: [],
          data: {
            operationId: proposal.target.operationId,
            planHash: 'slides-save-proposal-plan-hash',
            contentVersion: 2,
          },
        },
      },
      clientId,
    )
    await until(() => router.hasApproval('slides-save-proposal-approval-1'))
    expect(operations.lookup(proposal.target.operationId)).toBeUndefined()

    router.handleClientFrame(
      {
        type: 'approval:response',
        protocolVersion: PROTOCOL_VERSION,
        id: 'slides-save-proposal-approval-1' as RequestId,
        outcome: 'allowed-once',
      },
      clientId,
    )
    await until(() => sent.filter((frame) => frame.type === 'editor:request').length === 2)

    expect(sent.filter((frame) => frame.type === 'editor:request').at(-1)).toMatchObject({
      command: 'save_presentation',
      target: { operationId: proposal.target.operationId },
      arguments: { inPlace: true, contentVersion: 2 },
    })
    router.dispose()
  })

  it('does not reserve a PDF propose_save result in the operation journal', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'pdf', revision }])
    const operations = new OperationStore()
    documents.register({ documentId, clientId, editorType: 'pdf', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const router = new AgentRouter({
      supervisor,
      documents,
      operations,
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
        prompt: 'hello',
      },
      clientId,
    )

    const operationId = 'pdf-save-operation-1' as OperationId
    const request: EditorRequestFrame = {
      type: 'editor:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'pdf-save-proposal-request-1' as RequestId,
      target: {
        sessionId,
        documentId,
        editorType: 'pdf',
        revision,
        operationId,
        clientId,
      },
      command: 'propose_save',
      arguments: {},
    }
    router.routeRuntimeFrame(request)
    expect(sent).toContainEqual(request)

    router.handleClientFrame(
      {
        type: 'editor:result',
        protocolVersion: PROTOCOL_VERSION,
        id: request.id,
        target: request.target,
        result: {
          ok: true,
          summary: 'Save the current PDF in place.',
          warnings: [],
          data: {
            operationId,
            planHash: 'pdf-save-plan-1',
            snapshotHash: 'pdf-snapshot-1',
          },
        },
      },
      clientId,
    )

    expect(operations.lookup(operationId)).toBeUndefined()
    router.dispose()
  })

  it('replays a terminal PDF save with the proposal operation id and no second browser approval', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'pdf', revision }])
    const operations = new OperationStore()
    documents.register({ documentId, clientId, editorType: 'pdf', revision })
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const sent: AgentServerFrame[] = []
    const respondApproval = vi.spyOn(supervisor, 'respondApproval')
    const respondEditor = vi.spyOn(supervisor, 'respondEditor')
    const router = new AgentRouter({
      supervisor,
      documents,
      operations,
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
        prompt: 'hello',
      },
      clientId,
    )

    const operationId = 'pdf-save-operation-1' as OperationId
    const planHash = 'pdf-save-plan-1'
    const proposal = {
      operationId,
      planHash,
      summary: 'Save the current PDF in place.',
      targets: ['current PDF'],
      warnings: [],
    }
    router.routeRuntimeFrame({
      type: 'approval:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'pdf-save-approval-1' as RequestId,
      sessionId,
      toolName: 'save_pdf',
      reason: proposal.summary,
      proposal,
    })
    router.handleClientFrame(
      {
        type: 'approval:response',
        protocolVersion: PROTOCOL_VERSION,
        id: 'pdf-save-approval-1' as RequestId,
        outcome: 'allowed-once',
      },
      clientId,
    )

    const request: EditorRequestFrame = {
      type: 'editor:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'pdf-save-request-1' as RequestId,
      target: {
        sessionId,
        documentId,
        editorType: 'pdf',
        revision,
        operationId,
        clientId,
      },
      command: 'save_pdf',
      arguments: { inPlace: true },
      approval: { id: 'pdf-save-approval-1' as RequestId, planHash },
    }
    router.routeRuntimeFrame(request)
    const result = {
      ok: true,
      summary: 'Saved the current PDF in place.',
      warnings: [],
      verification: { passed: true, issues: [] },
    }
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

    router.routeRuntimeFrame({
      type: 'approval:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'pdf-save-approval-replay' as RequestId,
      sessionId,
      toolName: 'save_pdf',
      reason: proposal.summary,
      proposal,
    })
    router.routeRuntimeFrame({
      ...request,
      id: 'pdf-save-request-replay' as RequestId,
      approval: { id: 'pdf-save-approval-replay' as RequestId, planHash },
    })

    expect(sent.filter((frame) => frame.type === 'approval:request')).toHaveLength(1)
    expect(sent.filter((frame) => frame.type === 'editor:request')).toHaveLength(1)
    expect(respondApproval).toHaveBeenCalledWith('pdf-save-approval-replay', 'allowed-once')
    expect(respondEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'editor:result',
        id: 'pdf-save-request-replay',
        target: expect.objectContaining({ operationId }),
        result,
      }),
    )
    router.dispose()
  })

  it('expires a pending approval and sends one terminal failure when runtime crashes', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'sheets', revision }])
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
    const documents = new DocumentRegistry([{ documentId, editorType: 'sheets', revision }])
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
    const documents = new DocumentRegistry([
      { documentId, editorType: 'sheets', revision },
      { documentId: otherDocumentId, editorType: 'sheets', revision },
    ])
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
    const documents = new DocumentRegistry([{ documentId, editorType: 'sheets', revision }])
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

  it('records one terminal editor result, tolerates its transport duplicate, and serves it after browser reconnect', async () => {
    const documents = new DocumentRegistry([{ documentId, editorType: 'sheets', revision }])
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
    expect(() =>
      router.handleClientFrame(
        {
          type: 'editor:result',
          protocolVersion: PROTOCOL_VERSION,
          id: request.id,
          target: request.target,
          result,
        },
        clientId,
      ),
    ).not.toThrow()
    expect(operations.lookup('operation-1' as OperationId)).toMatchObject({
      state: 'committed',
      result,
    })
    expect(() =>
      router.handleClientFrame(
        {
          type: 'editor:result',
          protocolVersion: PROTOCOL_VERSION,
          id: request.id,
          target: request.target,
          result: { ...result, summary: 'Forged duplicate.' },
        },
        clientId,
      ),
    ).toThrow(/does not own operation/)
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
    documents.detachClient(clientId)
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
    const documents = new DocumentRegistry([{ documentId, editorType: 'sheets', revision }])
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
      revision,
    })
    router.handleClientFrame(
      {
        type: 'editor:register',
        protocolVersion: PROTOCOL_VERSION,
        id: 'register-recovered' as RequestId,
        clientId: reconnectedClientId,
        documentId,
        editorType: 'sheets',
        revision,
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
