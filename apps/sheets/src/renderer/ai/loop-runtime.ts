import {
  AgentLoop,
  type AgentImage,
  type AgentLoopOptions,
  type AgentMessage,
  type AgentToolCall,
  type ToolExecution,
} from '@genoffice/agent-core'
import type {
  AgentEventFrame,
  AgentServerFrame,
  ApprovalRequestFrame,
  DocumentId,
} from '@nexusdesk/protocol'
import type { AgentApi } from '@nexusdesk/web-client'

export interface AgentLoopLike {
  readonly busy: boolean
  readonly messages: readonly AgentMessage[]
  run(instruction: string, images?: AgentImage[]): void
  cancel(): void
  reset(): void
  restore(messages: readonly AgentMessage[]): void
}

export interface AgentLoopRuntimeOptions<T> extends AgentLoopOptions<T> {
  getDocumentId(): DocumentId | null
}

export function createAgentLoopRuntime<T>(
  options: AgentLoopRuntimeOptions<T>,
  api: AgentApi | undefined = typeof window === 'undefined' ? undefined : window.agentApi,
): AgentLoopLike {
  return api === undefined ? new AgentLoop(options) : new HostAgentLoop(options, api)
}

const WRITE_TOOLS = new Set(['apply_sheet_operations', 'create_sheet', 'apply_live_operations'])

class HostAgentLoop implements AgentLoopLike {
  private readonly sessionId = `sheets-${String(Date.now())}`
  private readonly unsubscribe: () => void
  private answer = ''
  private readonly toolNames = new Map<string, string>()
  private history: AgentMessage[] = []
  private active = false

  constructor(
    private readonly options: AgentLoopRuntimeOptions<unknown>,
    private readonly api: AgentApi,
  ) {
    this.unsubscribe = api.onFrame((frame) => this.onFrame(frame))
  }

  get busy(): boolean {
    return this.active
  }

  get messages(): readonly AgentMessage[] {
    return this.history
  }

  run(instruction: string, images?: AgentImage[]): void {
    if (images !== undefined && images.length > 0) {
      this.options.events?.onError?.('图像输入尚未接到 agent 运行时，请先去掉附件再发送。')
      return
    }
    const documentId = this.options.getDocumentId()
    if (documentId === null) {
      this.options.events?.onError?.('请先打开一个工作簿再让 AI 编辑。')
      return
    }
    this.active = true
    this.answer = ''
    this.history = [...this.history, { role: 'user', text: instruction }]
    this.api.startTurn({ prompt: instruction, documentId, sessionId: this.sessionId })
  }

  cancel(): void {
    this.api.cancelTurn(this.sessionId)
  }

  reset(): void {
    this.history = []
    this.answer = ''
    this.active = false
  }

  restore(messages: readonly AgentMessage[]): void {
    this.history = [...messages]
  }

  private onFrame(frame: AgentServerFrame): void {
    if (frame.type === 'agent:event' && frame.sessionId === this.sessionId) this.onEvent(frame)
    else if (frame.type === 'approval:request' && frame.sessionId === this.sessionId) {
      this.onApproval(frame)
    } else if (frame.type === 'fatal') {
      this.active = false
      this.options.events?.onError?.(frame.message || 'the agent runtime stopped')
    }
  }

  private onEvent(frame: AgentEventFrame): void {
    const data = asRecord(frame.event.data)
    if (frame.event.type === 'stream/chunk') this.onChunk(data)
    else if (frame.event.type === 'tool/call') this.forEachBlock(data, (part) => this.onToolCall(part))
    else if (frame.event.type === 'tool/result') this.forEachBlock(data, (part) => this.onToolResult(part))
    else if (frame.event.type === 'turn/end') this.onTurnEnd(data)
  }

  private forEachBlock(data: Record<string, unknown>, visit: (part: Record<string, unknown>) => void): void {
    const message = asRecord(data.message)
    for (const block of asArray(message.content)) visit(asRecord(block))
  }

  private onChunk(data: Record<string, unknown>): void {
    if (data.type !== 'text-delta' || typeof data.text !== 'string') return
    this.answer += data.text
    this.options.events?.onText?.(this.answer)
  }

  private onToolCall(part: Record<string, unknown>): void {
    if (part.type !== 'tool-call' || typeof part.id !== 'string' || typeof part.name !== 'string') return
    this.toolNames.set(part.id, part.name)
    const call: AgentToolCall = {
      id: part.id,
      name: part.name,
      input: asRecord(typeof part.arguments === 'string' ? safeParse(part.arguments) : part.arguments),
    }
    this.options.events?.onToolStart?.(call)
  }

  private onToolResult(part: Record<string, unknown>): void {
    if (typeof part.toolCallId !== 'string') return
    const name = this.toolNames.get(part.toolCallId) ?? 'tool'
    const isError = part.isError === true
    const execution: ToolExecution = {
      output: textOf(part.content),
      isError,
      mutated: !isError && WRITE_TOOLS.has(name),
      summary: `${name} ${isError ? 'failed' : 'done'}`,
    }
    this.options.events?.onToolExecuted?.({
      call: { id: part.toolCallId, name, input: {} },
      execution,
    })
  }

  private onTurnEnd(data: Record<string, unknown>): void {
    this.active = false
    const reason = asRecord(data.reason)
    const kind = typeof reason.kind === 'string' ? reason.kind : undefined
    if (kind === 'error' || kind === undefined) {
      const error = asRecord(reason.error)
      this.options.events?.onError?.(
        typeof error.message === 'string' ? error.message : 'the run stopped before answering',
      )
    } else {
      this.history = [...this.history, { role: 'assistant', text: this.answer }]
      this.options.events?.onDone?.({
        text: this.answer,
        cancelled: kind === 'aborted',
        turnLimit: false,
      })
    }
    this.options.events?.onTurnEnd?.()
  }

  private onApproval(frame: ApprovalRequestFrame): void {
    const detail = safeParse(frame.reason ?? '')
    const operationsValue = asRecord(detail).operations
    const operations = Array.isArray(operationsValue) ? operationsValue.map(String) : []
    const label = frame.toolName || 'write'
    const message = operations.length === 0
      ? `${label}：要修改文档，允许吗？`
      : `${label} 准备执行以下操作：\n${operations.map((operation) => ` · ${operation}`).join('\n')}\n\n允许吗？`
    const allowed = globalThis.confirm?.(message) ?? false
    this.api.respondApproval(frame.id, allowed ? 'allowed-once' : 'rejected')
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return asArray(content)
    .map((block) => {
      const part = asRecord(block)
      return typeof part.text === 'string' ? part.text : ''
    })
    .filter(Boolean)
    .join('\n')
}
