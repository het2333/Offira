import {
  PROTOCOL_VERSION,
  type AgentToolResult,
  type ApprovedEditPlan,
  type ClientId,
  type DocumentId,
  type EditorAdapter,
  type EditorRequestFrame,
  type Revision,
} from '@nexusdesk/protocol'
import {
  createAgentApi,
  registerEditor,
  type AgentApi,
  type EditorRegistrationHandle,
  type NexusClient,
} from '@nexusdesk/web-client'

export interface BrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: EditorAdapter): void
  client(): { clientId: ClientId | undefined; attached: boolean }
  consumeApproval(approvalId: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  dispose(): void
}

export interface BrowserAgentBridgeOptions {
  client: NexusClient
  documentId: DocumentId
  revision: Revision
}

function failure(code: string, message: string): AgentToolResult {
  return { ok: false, summary: message, warnings: [{ code, message }] }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'the editor request failed'
}

export function createBrowserAgentBridge(options: BrowserAgentBridgeOptions): BrowserAgentBridge {
  let adapter: EditorAdapter | undefined
  const approvals = new Map<string, string>()
  const registration: EditorRegistrationHandle = registerEditor(options.client, {
    documentId: options.documentId,
    editorType: 'sheets',
    revision: options.revision,
  })

  const sendResult = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    options.client.send({
      type: 'editor:result',
      protocolVersion: PROTOCOL_VERSION,
      id: frame.id,
      target: frame.target,
      result,
    })
  }

  const execute = async (frame: EditorRequestFrame): Promise<AgentToolResult> => {
    if (adapter === undefined) {
      return failure('EDITOR_NOT_READY', 'the spreadsheet editor is not ready')
    }
    if (frame.command === 'read_sheet') {
      return adapter.read({
        documentId: frame.target.documentId,
        command: frame.command,
        arguments: frame.arguments,
      })
    }
    if (frame.command === 'save_sheet') {
      return adapter.save(frame.target.documentId)
    }
    if (frame.command === 'apply_ops') {
      const plan = await adapter.propose({
        ...frame.target,
        command: frame.command,
        arguments: frame.arguments,
      })
      approvals.set(frame.id, plan.planHash)
      try {
        return await adapter.apply({ ...plan, approvalId: frame.id } as ApprovedEditPlan)
      } finally {
        approvals.delete(frame.id)
      }
    }
    return failure('UNAVAILABLE_IN_WEB', `the command ${frame.command} is unavailable in Web Sheets`)
  }

  const unsubscribe = options.client.onFrame((frame) => {
    if (frame.type !== 'editor:request') return
    void execute(frame)
      .then((result) => sendResult(frame, result))
      .catch((error: unknown) => {
        sendResult(frame, failure('EDITOR_REQUEST_FAILED', errorMessage(error)))
      })
  })

  return {
    agentApi: createAgentApi(options.client),
    attachEditor(nextAdapter) {
      adapter = nextAdapter
    },
    client() {
      return {
        clientId: options.client.clientId,
        attached: options.client.state === 'ready',
      }
    },
    consumeApproval(approvalId, planHash) {
      if (approvals.get(approvalId) !== planHash) return false
      approvals.delete(approvalId)
      return true
    },
    updateRevision(revision) {
      registration.updateRevision(revision)
    },
    dispose() {
      approvals.clear()
      adapter = undefined
      unsubscribe()
      registration.dispose()
    },
  }
}
