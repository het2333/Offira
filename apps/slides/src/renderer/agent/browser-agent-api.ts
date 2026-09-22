import {
  BoundedEditorCache,
  createEditorResultJournal,
  editorRequestFingerprint,
} from '@nexusdesk/web-client'
import {
  PROTOCOL_VERSION,
  type AgentToolResult,
  type ApprovedEditPlan,
  type ClientId,
  type DocumentId,
  type EditorAdapter,
  type EditorRequestFrame,
  type EditRequest,
  type EditPlan,
  type Revision,
} from '@nexusdesk/protocol'
import {
  createAgentApi,
  registerEditor,
  type AgentApi,
  type NexusClient,
} from '@nexusdesk/web-client'

export interface SlidesBrowserAgentBridge {
  readonly agentApi: AgentApi
  attachEditor(adapter: EditorAdapter): () => void
  client(): { clientId: ClientId | undefined; attached: boolean }
  transportClient(): NexusClient
  consumeApproval(approvalId: string, planHash: string): boolean
  updateRevision(revision: Revision): void
  dispose(): void
}

export interface SlidesBrowserAgentBridgeOptions {
  client: NexusClient
  documentId: DocumentId
  revision: Revision
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

interface SaveProposal {
  planHash: string
  contentVersion: number
  summary: string
  targets: string[]
  warnings: AgentToolResult['warnings']
}

interface HistoryProposal {
  planHash: string
  contentVersion: number
  summary: string
  targets: string[]
  warnings: AgentToolResult['warnings']
  operations: Array<{ action: 'undo' | 'redo' }>
}

type SaveProposalAdapter = EditorAdapter & {
  proposeSave?(request: EditRequest): Promise<SaveProposal>
}

type HistoryProposalAdapter = EditorAdapter & {
  proposeHistory?(request: EditRequest): Promise<HistoryProposal>
  applyHistory?(
    plan: HistoryProposal & { target: EditorRequestFrame['target']; approvalId: string },
  ): Promise<AgentToolResult>
}

function failure(code: string, message: string): AgentToolResult {
  return { ok: false, summary: message, warnings: [{ code, message }] }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const record = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(record[key]))
      .join(',') +
    '}'
  )
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

function contentVersion(argumentsValue: unknown): number | undefined {
  if (
    typeof argumentsValue !== 'object' ||
    argumentsValue === null ||
    Array.isArray(argumentsValue)
  )
    return undefined
  const value = (argumentsValue as Record<string, unknown>).contentVersion
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function createSlidesBrowserAgentBridge(
  options: SlidesBrowserAgentBridgeOptions,
): SlidesBrowserAgentBridge {
  let adapter: EditorAdapter | undefined
  let disposed = false
  let registered = false
  const unsubscribeState = options.client.onState(state => {
    if (state !== 'ready') registered = false
  })
  // Serialize only fingerprint/registration, not execution, to preserve first-arrival ownership.
  let requestQueue: Promise<void> = Promise.resolve()
  const releasedProposals = new BoundedEditorCache<string, boolean>()
  const terminalResults = new Map<
    string,
    { fingerprint: string; result: Promise<AgentToolResult> }
  >()
  const approvals = new Map<string, string>()
  const proposals = new BoundedEditorCache<string, EditPlan>()
  const saveProposals = new BoundedEditorCache<string, SaveProposal>()
  const historyProposals = new BoundedEditorCache<string, HistoryProposal>()
  const storage = options.storage ?? defaultStorage()
  const journal = createEditorResultJournal(storage, options.documentId)
  const registration = registerEditor(options.client, {
    documentId: options.documentId,
    editorType: 'slides',
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
  const deliverResult = (frame: EditorRequestFrame, result: AgentToolResult): void => {
    try {
      sendResult(frame, result)
    } catch {
      /* journal replays after reconnect */
    }
  }
  const execute = async (frame: EditorRequestFrame): Promise<AgentToolResult> => {
    if (adapter === undefined)
      return failure('EDITOR_NOT_READY', 'the presentation editor is not ready')
    if (frame.command === 'read_presentation')
      return adapter.read({
        documentId: frame.target.documentId,
        command: frame.command,
        arguments: frame.arguments,
      })
    if (frame.command === 'propose_save') {
      const saveAdapter = adapter as SaveProposalAdapter
      if (saveAdapter.proposeSave === undefined) {
        return failure(
          'UNAVAILABLE_IN_WEB',
          'the presentation editor cannot prepare an in-place save',
        )
      }
      const plan = await saveAdapter.proposeSave({
        ...frame.target,
        command: 'save_presentation',
        arguments: {},
      })
      saveProposals.set(frame.target.operationId, plan)
      return {
        ok: true,
        summary: plan.summary,
        warnings: plan.warnings,
        data: {
          operationId: frame.target.operationId,
          planHash: plan.planHash,
          summary: plan.summary,
          targets: plan.targets,
          contentVersion: plan.contentVersion,
        },
      }
    }
    if (frame.command === 'save_presentation') {
      const expectedContentVersion = contentVersion(frame.arguments)
      if (expectedContentVersion === undefined) {
        return failure(
          'SAVE_VERSION_REQUIRED',
          'save_presentation must name the in-memory presentation version it was approved to save',
        )
      }
      const plan = saveProposals.get(frame.target.operationId)
      if (
        plan === undefined ||
        frame.approval === undefined ||
        frame.approval.planHash !== plan.planHash ||
        expectedContentVersion !== plan.contentVersion
      ) {
        return failure(
          'APPROVAL_INVALID',
          'save request is not bound to a proposed presentation version',
        )
      }
      const save = adapter.save as (
        documentId: DocumentId,
        expectedContentVersion?: number,
      ) => Promise<AgentToolResult>
      try {
        return await save(frame.target.documentId, expectedContentVersion)
      } finally {
        saveProposals.delete(frame.target.operationId)
      }
    }
    if (frame.command === 'propose_history') {
      const historyAdapter = adapter as HistoryProposalAdapter
      if (historyAdapter.proposeHistory === undefined) {
        return failure(
          'UNAVAILABLE_IN_WEB',
          'the presentation editor cannot prepare a history change',
        )
      }
      const plan = await historyAdapter.proposeHistory({
        ...frame.target,
        command: 'propose_history',
        arguments: frame.arguments,
      })
      historyProposals.set(frame.target.operationId, plan)
      return {
        ok: true,
        summary: plan.summary,
        warnings: plan.warnings,
        data: {
          operationId: frame.target.operationId,
          planHash: plan.planHash,
          summary: plan.summary,
          targets: plan.targets,
          contentVersion: plan.contentVersion,
        },
      }
    }
    if (frame.command === 'apply_history') {
      const historyAdapter = adapter as HistoryProposalAdapter
      const plan = historyProposals.get(frame.target.operationId)
      if (
        plan === undefined ||
        historyAdapter.applyHistory === undefined ||
        frame.approval === undefined ||
        frame.approval.planHash !== plan.planHash ||
        canonical(frame.arguments) !== canonical(plan.operations[0])
      ) {
        return failure(
          'APPROVAL_INVALID',
          'history request is not bound to a proposed presentation change',
        )
      }
      approvals.set(frame.approval.id, plan.planHash)
      try {
        return await historyAdapter.applyHistory({
          ...plan,
          target: frame.target,
          approvalId: frame.approval.id,
        })
      } finally {
        approvals.delete(frame.approval.id)
        historyProposals.delete(frame.target.operationId)
      }
    }
    if (frame.command === 'propose_ops') {
      const plan = await adapter.propose({
        ...frame.target,
        command: 'apply_ops',
        arguments: frame.arguments,
      })
      proposals.set(frame.target.operationId, plan)
      return {
        ok: true,
        summary: plan.summary,
        warnings: plan.warnings,
        data: {
          operationId: frame.target.operationId,
          planHash: plan.planHash,
          summary: plan.summary,
          targets: plan.operations.flatMap((operation) =>
            typeof operation === 'object' && operation !== null && !Array.isArray(operation)
              ? [String((operation as Record<string, unknown>).op ?? 'change')]
              : [],
          ),
        },
      }
    }
    if (frame.command === 'apply_ops') {
      const plan = proposals.get(frame.target.operationId)
      if (
        plan === undefined ||
        frame.approval === undefined ||
        frame.approval.planHash !== plan.planHash
      )
        return failure('APPROVAL_INVALID', 'apply request is not bound to a proposed plan')
      approvals.set(frame.approval.id, plan.planHash)
      try {
        return await adapter.apply({ ...plan, approvalId: frame.approval.id } as ApprovedEditPlan)
      } finally {
        approvals.delete(frame.approval.id)
        proposals.delete(frame.target.operationId)
      }
    }
    return failure(
      'UNAVAILABLE_IN_WEB',
      `the command ${frame.command} is unavailable in Web Slides`,
    )
  }
  const replay = (frame: EditorRequestFrame, fingerprint: string): AgentToolResult | undefined => {
    if (frame.command.startsWith('propose_')) return undefined
    const record = journal.read(frame.target.operationId)
    if (!record) return undefined
    return record.fingerprint === fingerprint
      ? record.result
      : failure('OPERATION_ID_COLLISION', 'operation id is bound to different editor arguments')
  }
  const remember = (
    frame: EditorRequestFrame,
    result: AgentToolResult,
    fingerprint: string,
  ): void => {
    if (!frame.command.startsWith('propose_'))
      journal.write(frame.target.operationId, { fingerprint, result })
  }
  const releaseProposal = (operationId: string): void => {
    saveProposals.delete(operationId)
    proposals.delete(operationId)
    historyProposals.delete(operationId)
    releasedProposals.set(operationId, true)
  }
  const handleRequest = async (frame: EditorRequestFrame): Promise<void> => {
    if (disposed) return
    const fingerprint = await editorRequestFingerprint(frame)
    if (disposed) return
    const terminal = !frame.command.startsWith('propose_')
    const running = terminal ? terminalResults.get(frame.target.operationId) : undefined
    if (running) {
      if (running.fingerprint !== fingerprint) {
        deliverResult(
          frame,
          failure('OPERATION_ID_COLLISION', 'operation id is bound to different editor arguments'),
        )
      } else {
        void running.result.then((result) => deliverResult(frame, result))
      }
      return
    }
    const replayed = replay(frame, fingerprint)
    if (replayed !== undefined) {
      deliverResult(frame, replayed)
      return
    }
    if (releasedProposals.has(frame.target.operationId)) {
      deliverResult(frame, failure('APPROVAL_INVALID', 'the proposal was released'))
      return
    }
    // Schedule execution after the shared promise is registered, including synchronous failures.
    const resultPromise = Promise.resolve().then(async () => {
      let result: AgentToolResult
      try {
        result = await execute(frame)
        if (
          frame.command.startsWith('propose_') &&
          (disposed || releasedProposals.has(frame.target.operationId))
        ) {
          saveProposals.delete(frame.target.operationId)
          proposals.delete(frame.target.operationId)
          historyProposals.delete(frame.target.operationId)
          result = failure('APPROVAL_INVALID', 'the proposal was released')
        }
      } catch (error) {
        result = failure(
          'EDITOR_REQUEST_FAILED',
          error instanceof Error ? error.message : String(error),
        )
      }
      try {
        remember(frame, result, fingerprint)
      } catch {
        /* The in-memory result remains authoritative if storage is unavailable. */
      }
      return result
    })
    if (terminal)
      terminalResults.set(frame.target.operationId, {
        fingerprint,
        result: resultPromise,
      })
    void resultPromise.then((result) => {
      if (terminalResults.get(frame.target.operationId)?.result === resultPromise)
        terminalResults.delete(frame.target.operationId)
      deliverResult(frame, result)
    })
  }
  const unsubscribe = options.client.onFrame((frame) => {
    if (disposed) return
    if (frame.type === 'editor:attached' && frame.documentId === options.documentId) {
      registered = true
      return
    }
    if (frame.type === 'agent:event' && frame.event.type === 'editor:proposal-released') {
      const data = frame.event.data
      if (
        data &&
        typeof data === 'object' &&
        !Array.isArray(data) &&
        typeof data.operationId === 'string'
      )
        releaseProposal(data.operationId)
      return
    }
    if (frame.type === 'editor:request')
      requestQueue = requestQueue
        .then(() => handleRequest(frame))
        .catch((error: unknown) =>
          deliverResult(
            frame,
            failure(
              'EDITOR_REQUEST_FAILED',
              error instanceof Error ? error.message : String(error),
            ),
          ),
        )
  })

  return {
    agentApi: createAgentApi(options.client),
    attachEditor(nextAdapter) {
      adapter = nextAdapter
      return () => {
        if (adapter === nextAdapter) adapter = undefined
      }
    },
    transportClient: () => options.client,
    client() {
      return { clientId: options.client.clientId, attached: registered && options.client.state === 'ready' }
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
      disposed = true
      releasedProposals.clear()
      terminalResults.clear()
      journal.clearMemory()
      approvals.clear()
      proposals.clear()
      saveProposals.clear()
      historyProposals.clear()
      adapter = undefined
      unsubscribe()
      unsubscribeState()
      registration.dispose()
    },
  }
}
