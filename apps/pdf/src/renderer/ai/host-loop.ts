import type { AgentLoopOptions, AgentMessage } from '@genoffice/agent-core'
import type { ApprovalRequestFrame, AgentServerFrame } from '@nexusdesk/protocol'
import type { AgentApi } from '@nexusdesk/web-client'

export interface PdfPanelLoop {
  readonly busy: boolean
  run(instruction: string): void
  cancel(): void
  reset(): void
  restore(messages: readonly AgentMessage[]): void
  dispose?(): void
}

/** The shared PDF panel presents Host-owned Harness sessions in Local Web. */
export class PdfHostLoop implements PdfPanelLoop {
  private sessionId = `pdf-${crypto.randomUUID()}`
  private active = false
  private answer = ''
  private unsubscribe?: () => void
  private toolNames = new Map<string, string>()
  constructor(
    private readonly api: AgentApi,
    private readonly documentId: () => string | undefined,
    private readonly events: AgentLoopOptions['events'],
    private readonly confirm: (frame: ApprovalRequestFrame) => Promise<boolean>,
  ) {}
  get busy() {
    return this.active
  }
  run(prompt: string) {
    if (this.active) return
    const documentId = this.documentId()
    if (!documentId) {
      this.events?.onError?.('Open a PDF before starting the assistant.')
      return
    }
    this.unsubscribe ??= this.api.onFrame((frame) => this.onFrame(frame))
    this.active = true
    this.answer = ''
    try {
      this.api.startTurn({ prompt, documentId, sessionId: this.sessionId })
    } catch (error) {
      this.active = false
      this.events?.onError?.(String(error))
    }
  }
  cancel() {
    if (this.active) this.api.cancelTurn(this.sessionId)
  }
  reset() {
    this.cancel()
    this.active = false
    this.answer = ''
    this.sessionId = `pdf-${crypto.randomUUID()}`
  }
  restore(_messages: readonly AgentMessage[]) {
    /* Harness owns conversation history. */
  }
  dispose() {
    this.cancel()
    this.active = false
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }
  private onFrame(frame: AgentServerFrame) {
    if (!this.active) return
    if (frame.type === 'fatal') {
      this.active = false
      this.events?.onError?.(frame.message)
      return
    }
    if (
      (frame.type !== 'agent:event' && frame.type !== 'approval:request') ||
      frame.sessionId !== this.sessionId
    )
      return
    if (frame.type === 'approval:request') {
      void this.confirm(frame).then((approved) =>
        this.api.respondApproval(
          frame.id,
          approved && this.active && frame.sessionId === this.sessionId
            ? 'allowed-once'
            : 'rejected',
        ),
      )
      return
    }
    const data = (frame.event.data ?? {}) as Record<string, unknown>
    if (
      frame.event.type === 'stream/chunk' &&
      data.type === 'text-delta' &&
      typeof data.text === 'string'
    ) {
      this.answer += data.text
      this.events?.onText?.(this.answer)
    } else if (
      frame.event.type === 'tool/call' &&
      typeof data.callId === 'string' &&
      typeof data.name === 'string'
    ) {
      this.toolNames.set(data.callId, data.name)
      this.events?.onToolStart?.({ id: data.callId, name: data.name, input: {} })
    } else if (frame.event.type === 'tool/result' && typeof data.callId === 'string') {
      const name =
        typeof data.name === 'string' ? data.name : (this.toolNames.get(data.callId) ?? 'PDF tool')
      this.events?.onToolExecuted?.({
        call: { id: data.callId, name, input: {} },
        execution: {
          summary: `${name} ${data.isError ? 'failed' : 'completed'}`,
          output: typeof data.contentText === 'string' ? data.contentText : '',
          isError: data.isError === true,
          // Host save has its own exact approval; the panel must not trigger legacy autosave.
          mutated: false,
        },
      })
    } else if (frame.event.type === 'turn/end') {
      this.active = false
      const reason = data.reason as { kind?: string; error?: { message?: string } } | undefined
      if (!reason?.kind || reason.kind === 'error')
        this.events?.onError?.(
          reason?.error?.message ?? 'The PDF assistant stopped before completion.',
        )
      else
        this.events?.onDone?.({
          text: this.answer,
          cancelled: reason.kind === 'aborted',
          turnLimit: false,
        })
    }
  }
}
