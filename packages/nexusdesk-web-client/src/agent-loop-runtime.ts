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
} from '@nexusdesk/protocol'
import type { AgentApi } from './agent-api'
import { showApprovalDialog } from './approval-dialog'

export interface AgentLoopLike {
  readonly busy: boolean
  readonly messages: readonly AgentMessage[]
  run(instruction: string, images?: AgentImage[]): void
  cancel(): void
  reset(): void
  restore(messages: readonly AgentMessage[]): void
}

export interface AgentLoopRuntimeOptions<T> extends AgentLoopOptions<T> {
  getDocumentId(): string | null
}

export function createAgentLoopRuntime<T>(
  options: AgentLoopRuntimeOptions<T>,
  api: AgentApi | undefined = typeof window === 'undefined' ? undefined : (window as Window & { agentApi?: AgentApi }).agentApi,
): AgentLoopLike {
  return api === undefined ? new AgentLoop(options) : new HostAgentLoop(options, api)
}

const WRITE_TOOLS = new Set(['apply_sheet_operations', 'apply_document_operations', 'apply_presentation_operations', 'create_sheet', 'apply_live_operations'])

class HostAgentLoop implements AgentLoopLike {
  private sessionId = `office-${globalThis.crypto.randomUUID()}`
  private readonly unsubscribe: () => void
  private answer = ''
  private readonly toolNames = new Map<string, string>()
  private history: AgentMessage[] = []
  private active = false
  private readonly pendingApprovals = new Map<string, () => void>()

  constructor(
    private readonly options: AgentLoopRuntimeOptions<unknown>,
    private readonly api: AgentApi,
  ) {
    this.unsubscribe = api.onFrame((frame) => this.onFrame(frame))
    api.onState?.((state) => {
      if (this.active && state !== 'ready') this.failConnection()
    })
  }

  get busy(): boolean {
    return this.active
  }

  get messages(): readonly AgentMessage[] {
    return this.history
  }

  run(instruction: string, images?: AgentImage[]): void {
    if (this.active) return
    if (images !== undefined && images.length > 0) {
      this.options.events?.onError?.('图像输入尚未接到 agent 运行时，请先去掉附件再发送。')
      return
    }
    const documentId = this.options.getDocumentId()
    if (documentId === null) {
      this.options.events?.onError?.('请先打开一个文件再让 AI 编辑。')
      return
    }
    this.active = true
    this.answer = ''
    this.history = [...this.history, { role: 'user', text: instruction }]
    try {
      this.api.startTurn({ prompt: instruction, documentId, sessionId: this.sessionId })
    } catch {
      this.failConnection()
    }
  }

  cancel(): void {
    if (!this.active) return
    try {
      this.closeApprovals()
      this.api.cancelTurn(this.sessionId)
    } catch {
      this.failConnection()
    }
  }

  private failConnection(): void {
    this.active = false
    // Quarantine late events; never replay a potentially executed mutation.
    this.sessionId = `office-${globalThis.crypto.randomUUID()}`
    this.closeApprovals()
    this.options.events?.onError?.('与本地服务的连接已中断，已结束等待。操作结果尚未核实，请恢复连接后先检查文件，不要重复提交修改。')
  }

  reset(): void {
    if (this.active) this.cancel()
    this.sessionId = `office-${globalThis.crypto.randomUUID()}`
    this.history = []
    this.answer = ''
    this.active = false
  }

  restore(messages: readonly AgentMessage[]): void {
    this.history = [...messages]
  }

  private onFrame(frame: AgentServerFrame): void {
    if (frame.type === 'recovery:required' && this.active && frame.documentId === this.options.getDocumentId()) {
      this.failConnection()
      return
    }
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
    else if (frame.event.type === 'tool/call') this.onToolCall(data)
    else if (frame.event.type === 'tool/result') this.onToolResult(data)
    else if (frame.event.type === 'turn/end') this.onTurnEnd(data)
  }

  private onChunk(data: Record<string, unknown>): void {
    if (data.type !== 'text-delta' || typeof data.text !== 'string') return
    this.answer += data.text
    this.options.events?.onText?.(this.answer)
  }

  private onToolCall(part: Record<string, unknown>): void {
    if (typeof part.callId !== 'string' || typeof part.name !== 'string') return
    this.toolNames.set(part.callId, part.name)
    const call: AgentToolCall = {
      id: part.callId,
      name: part.name,
      input: asRecord(part.arguments),
    }
    this.options.events?.onToolStart?.(call)
  }

  private onToolResult(part: Record<string, unknown>): void {
    if (typeof part.callId !== 'string') return
    const name =
      typeof part.name === 'string' ? part.name : (this.toolNames.get(part.callId) ?? 'tool')
    const isError = part.isError === true
    const execution: ToolExecution = {
      output: typeof part.contentText === 'string' ? part.contentText : '',
      isError,
      mutated: !isError && WRITE_TOOLS.has(name),
      summary: `${name} ${isError ? 'failed' : 'done'}`,
    }
    this.options.events?.onToolExecuted?.({
      call: { id: part.callId, name, input: {} },
      execution,
    })
  }

  private onTurnEnd(data: Record<string, unknown>): void {
    this.closeApprovals()
    this.active = false
    const reason = asRecord(data.reason)
    const kind = typeof reason.kind === 'string' ? reason.kind : undefined
    if (kind === 'error' || kind === undefined) {
      const error = asRecord(reason.error)
      this.options.events?.onError?.(
        typeof error.message === 'string'
          ? error.message.includes('Insufficient Balance')
            ? 'DeepSeek 账户余额不足，请充值后重试。'
            : error.message
          : 'AI 在回复前停止了运行，请重试。',
      )
    } else {
      this.history = [...this.history, { role: 'assistant', text: this.answer }]
      this.options.events?.onDone?.({
        text: this.answer,
        cancelled: kind === 'aborted',
        turnLimit: false,
      })
    }
    // Legacy onTurnEnd starts another assistant bubble; terminal Host events
    // are already settled by onDone/onError and must not reopen a spinner.
  }

  private onApproval(frame: ApprovalRequestFrame): void {
    if (this.pendingApprovals.has(frame.id)) return
    const label = frame.toolName || 'write'
    const proposal = frame.proposal
    const targetLines = proposal?.targets.map((target) => ` · ${target}`).join('\n') ?? ''
    const warningLines =
      proposal?.warnings.map((warning) => ` ⚠ ${warning.message}`).join('\n') ?? ''
    const message =
      proposal === undefined
        ? `${label}：${frame.reason ?? '要修改文档'}，允许吗？`
        : [
            `${label}：${proposal.summary}`,
            targetLines,
            warningLines,
            `计划校验值：${proposal.planHash}`,
            '允许执行这个确切计划吗？',
          ]
            .filter(Boolean)
            .join('\n')
    this.pendingApprovals.set(frame.id, showApprovalDialog(message, (allowed) => {
      this.pendingApprovals.delete(frame.id)
      this.api.respondApproval(frame.id, allowed ? 'allowed-once' : 'rejected')
    }, {
      title: label.startsWith('save_') ? '保存当前文件？' : '确认以下修改？',
      summary: (label.startsWith('save_')
        ? '将当前内容写入原文件。'
        : '请核对修改内容，确认后才会执行。') + (warningLines ? `\n${warningLines}` : ''),
      items: label.startsWith('save_') ? [] : (proposal?.targets ?? [proposal?.summary ?? frame.reason ?? '修改当前文件']),
    }))
  }

  private closeApprovals(): void {
    for (const close of this.pendingApprovals.values()) {
      try { close() } catch { /* A disconnected channel cannot receive rejection. */ }
    }
    this.pendingApprovals.clear()
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
