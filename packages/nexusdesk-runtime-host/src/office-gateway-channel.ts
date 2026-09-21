import { randomUUID } from 'node:crypto'
import type { OfficeGatewayResult } from './office-gateway-fetch'
import {
  authorizeOfficeGatewayRequest,
  filterOfficeControlFrame,
  OfficeRemoteEventFilter,
} from './office-gateway-policy'

interface OfficeGatewayChannelOptions {
  readonly sessionId: string
  /** Recheck the live editor target on every admission and stream delivery. */
  readonly assertOwner: () => void
  /** Consume the exact native requestId's Host-validated context; never start a second prompt. */
  readonly preparePrompt: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  readonly dispatch: (
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ) => Promise<OfficeGatewayResult>
  readonly open: (endpoint: string, payload: unknown, signal: AbortSignal) => AsyncIterable<unknown>
}

/** A single authenticated document client. Transport disconnect must close this object.
 * Stream pumping belongs outside the physical socket's finite request queue.
 */
export class OfficeGatewayChannel {
  private readonly lifetime = new AbortController()
  private readonly streams = new Map<
    string,
    { abort: AbortController; events?: OfficeRemoteEventFilter; token?: string }
  >()

  constructor(private readonly options: OfficeGatewayChannelOptions) {}

  private assertLive(): void {
    this.lifetime.signal.throwIfAborted()
    this.options.assertOwner()
  }

  async call(endpoint: string, input: unknown, signal?: AbortSignal): Promise<OfficeGatewayResult> {
    this.assertLive()
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    combined.throwIfAborted()
    let payload: Record<string, unknown>
    if (endpoint === '$events/result') {
      const token = (input as { args?: { clientId?: unknown } } | null)?.args?.clientId
      const stream = [...this.streams.values()].find(
        (entry) => entry.token === token && entry.events !== undefined,
      )
      if (!stream?.events) throw new Error('No active Office answer stream owns this result.')
      payload = stream.events.consume(input)
    } else {
      payload = authorizeOfficeGatewayRequest(this.options, 'call', endpoint, input)
      if (endpoint === 'session/prompt') {
        const requestId = (payload.args as { request: { requestId: string } }).request.requestId
        payload = await this.options.preparePrompt(payload)
        this.assertLive()
        // Context composition cannot switch the native target or request mode.
        payload = authorizeOfficeGatewayRequest(this.options, 'call', endpoint, payload)
        if ((payload.args as { request: { requestId: string } }).request.requestId !== requestId) {
          throw new Error('Office preparation changed the native request identity.')
        }
      }
    }
    combined.throwIfAborted()
    return this.options.dispatch(endpoint, payload, combined)
  }

  async *open(
    streamId: string,
    endpoint: string,
    input: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown> {
    this.assertLive()
    if (!streamId || this.streams.has(streamId) || this.streams.size >= 16)
      throw new Error('Invalid or duplicate Office stream.')
    const payload = authorizeOfficeGatewayRequest(this.options, 'stream', endpoint, input)
    if (endpoint === '$events' && [...this.streams.values()].some((entry) => entry.events)) {
      throw new Error('An Office answer stream is already active.')
    }
    const abort = new AbortController()
    const combined = AbortSignal.any([
      this.lifetime.signal,
      abort.signal,
      ...(signal ? [signal] : []),
    ])
    combined.throwIfAborted()
    const token = endpoint === '$events' ? randomUUID() : undefined
    const events = token ? new OfficeRemoteEventFilter(this.options.sessionId, token) : undefined
    const stream = { abort, ...(events ? { events, token: token! } : {}) }
    this.streams.set(streamId, stream)
    try {
      for await (const value of this.options.open(endpoint, payload, combined)) {
        this.assertLive()
        combined.throwIfAborted()
        if (events) {
          const filtered = events.receive(value)
          if (filtered.delegate) {
            const result = await this.options.dispatch(
              '$events/result',
              filtered.delegate,
              combined,
            )
            if (!result.ok) throw new Error('Unable to delegate unrelated Gateway event.')
          }
          if (filtered.forward) yield filtered.forward
        } else if (endpoint === 'session/control') {
          const filtered = filterOfficeControlFrame(this.options.sessionId, value)
          if (filtered) yield filtered
        } else {
          // session/follow is opened with an exact ordinary Session address.
          yield value
        }
      }
    } finally {
      abort.abort()
      events?.close()
      if (this.streams.get(streamId) === stream) this.streams.delete(streamId)
    }
  }

  cancel(streamId: string): void {
    const stream = this.streams.get(streamId)
    stream?.events?.close()
    stream?.abort.abort()
    this.streams.delete(streamId)
  }

  close(): void {
    this.lifetime.abort()
    for (const streamId of this.streams.keys()) this.cancel(streamId)
  }
}
