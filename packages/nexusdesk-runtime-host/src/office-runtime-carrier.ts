import type { ClientId, DocumentId, HarnessServerFrame, Revision } from '@nexusdesk/protocol'
import { OfficeGatewayChannel } from './office-gateway-channel'
import { projectOfficeDisplay } from './office-display'
import type { OfficeGatewayResult } from './office-gateway-fetch'
import { freezeOfficeTurnContext, officeTurnContextText, type OfficeTurnContext } from './office-session-binding'
import type { RuntimeRequestFrame, RuntimeResponseFrame } from './protocol'

type NativeRequest = Extract<RuntimeRequestFrame, { type: 'office:client' }>
interface Target { clientId: ClientId; documentId: DocumentId; editorType: string; revision: Revision }
interface Options {
  target(sessionId: string): Target | undefined
  send(frame: RuntimeResponseFrame): void
  dispatch(endpoint: string, payload: unknown, signal: AbortSignal): Promise<OfficeGatewayResult>
  open(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
}
interface ChannelEntry { clientId: ClientId; channel: OfficeGatewayChannel; contexts: Map<string, OfficeTurnContext> }

/** Finite IPC admissions with independently pumped, cancellable native streams. */
export class OfficeRuntimeCarrier {
  private readonly channels = new Map<string, ChannelEntry>()
  private readonly preparedRequests = new Set<string>()
  constructor(private readonly options: Options) {}

  private entry(input: NativeRequest): ChannelEntry {
    const key = JSON.stringify([input.clientId, input.sessionId, input.frame.documentId])
    const assertOwner = () => {
      const target = this.options.target(input.sessionId)
      if (!target || target.clientId !== input.clientId || target.documentId !== input.frame.documentId) throw new Error('Native Office session ownership changed.')
    }
    assertOwner()
    let entry = this.channels.get(key)
    if (entry) return entry
    if (this.channels.size >= 128) throw new Error('Too many Office channels.')
    const contexts = new Map<string, OfficeTurnContext>()
    const channel = new OfficeGatewayChannel({
      sessionId: input.sessionId, assertOwner,
      dispatch: this.options.dispatch,
      open: this.options.open,
      preparePrompt: async (payload) => {
        const args = payload.args as { request: Record<string, unknown> }
        const requestId = args.request.requestId as string
        const context = contexts.get(requestId)
        if (!context) throw new Error('Native prompt has no prepared Office context.')
        contexts.delete(requestId)
        const target = this.options.target(input.sessionId)!
        if (target.revision !== context.revision) throw new Error('Document changed after submission preparation.')
        if (!Array.isArray(args.request.content)) throw new Error('Invalid native prompt content.')
        return { args: { request: { ...args.request, content: [{ type: 'text', text: officeTurnContextText(context) }, ...args.request.content] } } }
      },
    })
    entry = { clientId: input.clientId, channel, contexts }
    this.channels.set(key, entry)
    return entry
  }

  async handle(input: NativeRequest): Promise<void> {
    const frame = input.frame
    const base = { protocolVersion: 1 as const, id: frame.id, documentId: frame.documentId }
    const send = (value: HarnessServerFrame) => this.options.send({ type: 'office:client-result', protocolVersion: 1, clientId: input.clientId, frame: projectOfficeDisplay(value, frame.documentId) })
    const fail = (_error: unknown) => send({ ...base, type: 'harness:error', message: '会话请求未能完成；如已提交修改，请先核实文档结果。' })
    try {
      const entry = this.entry(input)
      switch (frame.type) {
        case 'harness:prepare': {
          const identity = JSON.stringify([input.sessionId, frame.requestId])
          if (entry.contexts.size >= 128 || this.preparedRequests.size >= 10000 || this.preparedRequests.has(identity)) throw new Error('Duplicate or excessive Office submissions.')
          const context = freezeOfficeTurnContext(input.context)
          const target = this.options.target(input.sessionId)!
          if (context.documentId !== frame.documentId || context.editorType !== target.editorType || context.revision !== frame.revision || context.revision < target.revision) throw new Error('Prepared context does not match the bound document.')
          target.revision = context.revision
          entry.contexts.set(frame.requestId, context)
          this.preparedRequests.add(identity)
          send({ ...base, type: 'harness:prepared', requestId: frame.requestId })
          return
        }
        case 'harness:rpc': {
          const result = await entry.channel.call(frame.endpoint, frame.payload)
          send({ ...base, type: 'harness:result', result })
          return
        }
        case 'harness:stream-open':
          // Do not await: this iterator must never occupy the socket/IPC admission queue.
          void (async () => {
            try {
              for await (const value of entry.channel.open(frame.id, frame.endpoint, frame.payload)) send({ ...base, type: 'harness:stream-item', value })
              send({ ...base, type: 'harness:stream-end' })
            } catch (error) { fail(error) }
          })()
          return
        case 'harness:stream-cancel':
          entry.channel.cancel(frame.streamId)
          return
      }
    } catch (error) { fail(error) }
  }

  detach(clientId: ClientId): void {
    for (const [key, entry] of this.channels) {
      if (entry.clientId !== clientId) continue
      entry.channel.close(); entry.contexts.clear(); this.channels.delete(key)
    }
  }

  close(): void {
    for (const entry of this.channels.values()) { entry.channel.close(); entry.contexts.clear() }
    this.channels.clear()
    this.preparedRequests.clear()
  }
}
