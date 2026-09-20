import { expect, it } from 'vitest'
import type { AgentServerFrame, AgentToolResult, EditorRequestFrame } from '@nexusdesk/protocol'
import { AgentRouter } from '../src/agent-router'
import { DocumentRegistry } from '../src/document-registry'
import { OperationStore } from '../src/operation-store'
import type { HarnessSupervisor } from '../src/harness-supervisor'
import { createDocsTools } from '../../../packages/nexusdesk-runtime-host/src/docs-tools'
import { createSheetsTools } from '../../../packages/nexusdesk-runtime-host/src/sheets-tools'
import { createMarkdownTools } from '../../../packages/nexusdesk-runtime-host/src/markdown-tools'
import { createHtmlTools } from '../../../packages/nexusdesk-runtime-host/src/html-tools'

it.each([
  ['docs', 'save_document', createDocsTools],
  ['sheets', 'save_sheet', createSheetsTools],
  ['markdown', 'save_markdown', createMarkdownTools],
  ['html', 'save_html', createHtmlTools],
] as const)(
  '%s runtime save retries reuse the exact original proposal and terminal result',
  async (editorType, command, createTools) => {
    const documentId = 'document-1' as never,
      clientId = 'client-1' as never,
      sessionId = 'session-1' as never
    const documents = new DocumentRegistry([{ documentId, editorType, revision: 1 }])
    documents.register({ documentId, clientId, editorType, revision: 1 as never })
    const editors = new Map<string, (value: AgentToolResult) => void>()
    const approvals = new Map<string, (value: { approved: boolean; approvalId: string }) => void>()
    let requestId = 0,
      writes = 0,
      prompts = 0,
      proposals = 0,
      contentVersion = 1
    const supervisor = {
      onFrame: () => () => {},
      onExit: () => () => {},
      startTurn() {},
      respondEditor(frame: { id: string; result: AgentToolResult }) {
        editors.get(frame.id)!(frame.result)
      },
      respondApproval(id: string, outcome: string) {
        approvals.get(id)!({ approved: outcome === 'allowed-once', approvalId: id })
      },
    } as unknown as HarnessSupervisor
    const router = new AgentRouter({
      documents,
      operations: new OperationStore(),
      supervisor,
      sendToClient: (_client, frame: AgentServerFrame) => {
        if (frame.type === 'approval:request') {
          prompts++
          router.handleClientFrame(
            {
              type: 'approval:response',
              protocolVersion: 1,
              id: frame.id,
              outcome: 'allowed-once',
            },
            clientId,
          )
        }
        if (frame.type === 'editor:request') {
          let result: AgentToolResult
          if (frame.command === 'propose_save') {
            proposals++
            result = {
              ok: true,
              summary: 'Save the approved body',
              warnings: [],
              data: {
                operationId: frame.target.operationId,
                planHash: 'plan-' + contentVersion,
                snapshotHash: 'snapshot-' + contentVersion,
                targets: ['current document'],
              },
            }
          } else {
            writes++
            contentVersion++
            documents.commitRevision({ documentId, clientId, revision: contentVersion as never })
            result = { ok: true, summary: 'Saved original approved body', warnings: [] }
          }
          router.handleClientFrame(
            {
              type: 'editor:result',
              protocolVersion: 1,
              id: frame.id,
              target: frame.target,
              result,
            },
            clientId,
          )
        }
      },
    })
    router.handleClientFrame(
      {
        type: 'agent:start',
        protocolVersion: 1,
        id: 'start' as never,
        sessionId,
        documentId,
        prompt: 'save',
      },
      clientId,
    )
    const tools = createTools({
      request: (command, args, _execution, authorization) =>
        new Promise((resolve, reject) => {
          const id = 'request-' + ++requestId
          editors.set(id, resolve)
          const frame: EditorRequestFrame = {
            type: 'editor:request',
            protocolVersion: 1,
            id: id as never,
            target: {
              documentId,
              clientId,
              sessionId,
              editorType,
              revision: documents.assertClient(documentId, clientId).revision,
              operationId: 'same-tool-call' as never,
            },
            command,
            arguments: args,
            ...(authorization
              ? {
                  approval: {
                    id: authorization.approvalId as never,
                    planHash: authorization.planHash,
                  },
                }
              : {}),
          }
          try {
            router.routeRuntimeFrame(frame)
          } catch (error) {
            reject(error)
          }
        }),
      approve: (toolName, proposal) =>
        new Promise((resolve, reject) => {
          const id = 'approval-' + ++requestId
          approvals.set(id, resolve)
          try {
            router.routeRuntimeFrame({
              type: 'approval:request',
              protocolVersion: 1,
              id: id as never,
              sessionId,
              toolName,
              proposal,
            })
          } catch (error) {
            reject(error)
          }
        }),
    })
    const tool = tools.find((tool) => tool.name === command)!
    const first = await tool.execute({}, {} as never)
    const second = await tool.execute({}, {} as never)
    expect(second).toEqual(first)
    expect(writes).toBe(1)
    expect(prompts).toBe(1)
    expect(proposals).toBe(1)
    router.dispose()
  },
)
