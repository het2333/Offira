/** Document-scoped admission for the native Harness carrier. */
type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Office gateway object.')
  }
  return value as RecordValue
}

function exactKeys(value: RecordValue, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('Invalid Office gateway fields.')
  }
}

function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing Office gateway identity.')
  return value
}

/** Validate capability and Session ownership before passing arguments to the official decoder.
 * Prompt callers must additionally consume a Host-validated frozen submission context.
 */
export function authorizeOfficeGatewayRequest(
  binding: { readonly sessionId: string },
  mode: 'call' | 'stream',
  endpoint: string,
  payload: unknown,
): RecordValue {
  nonempty(binding.sessionId)
  const envelope = record(payload)
  exactKeys(envelope, ['args'])
  const args = record(envelope.args)
  if (mode === 'call' && endpoint === 'session/list') {
    exactKeys(args, ['_request'])
    exactKeys(record(args._request), [])
    return structuredClone(envelope)
  }
  const noArgs =
    mode === 'call'
      ? endpoint === 'session/modelCatalog' || endpoint === 'settings/describe'
      : endpoint === '$events' || endpoint === 'session/control' || endpoint === 'workspace/follow'
  if (noArgs) {
    exactKeys(args, [])
    return structuredClone(envelope)
  }
  const permitted =
    mode === 'call'
      ? [
          'session/prompt',
          'session/cancel',
          'session/selectModel',
          'session/page',
          'session/attachment',
        ]
      : ['session/follow']
  if (!permitted.includes(endpoint))
    throw new Error('This capability is not available in the Office panel.')
  exactKeys(args, ['request'])
  const request = record(args.request)
  if (endpoint === 'session/page' || endpoint === 'session/follow') {
    const address = record(request.address)
    exactKeys(address, ['kind', 'sessionId'])
    if (address.kind !== 'session' || address.sessionId !== binding.sessionId) {
      throw new Error('The requested history does not belong to this document.')
    }
  } else if (request.sessionId !== binding.sessionId) {
    throw new Error('The requested Session does not belong to this document.')
  }
  if (endpoint === 'session/prompt') {
    nonempty(request.requestId)
    if (request.mode !== 'queue') throw new Error('Office prompts require a new frozen submission.')
  }
  return structuredClone(envelope)
}

/** Keep official live-control records restricted to the bound document. */
export function filterOfficeControlFrame(
  sessionId: string,
  input: unknown,
): RecordValue | undefined {
  const frame = record(input)
  if (frame.type === 'baseline') {
    const value = record(frame.value)
    const jobs = record(value.jobs)
    const projections = record(value.projections)
    return {
      type: 'baseline',
      value: {
        jobs: Object.hasOwn(jobs, sessionId)
          ? { [sessionId]: structuredClone(jobs[sessionId]) }
          : {},
        projections: Object.hasOwn(projections, sessionId)
          ? { [sessionId]: structuredClone(projections[sessionId]) }
          : {},
      },
    }
  }
  if ((frame.type === 'jobs' || frame.type === 'projection') && frame.sessionId === sessionId) {
    return structuredClone(frame)
  }
  return undefined
}

interface FilteredEvent {
  readonly forward?: RecordValue
  /** Must be answered through the official Gateway, otherwise a hidden delivery can hang. */
  readonly delegate?: RecordValue
}

/** One native event stream's single-use answer ownership; close it on detach or disconnect. */
export class OfficeRemoteEventFilter {
  private gatewayClientId: string | undefined
  private readonly deliveries = new Map<string, string>()
  private closed = false

  constructor(
    private readonly sessionId: string,
    private readonly clientToken: string,
  ) {
    nonempty(sessionId)
    nonempty(clientToken)
  }

  receive(input: unknown): FilteredEvent {
    if (this.closed) throw new Error('Office event stream is closed.')
    const frame = record(input)
    if (frame.type === 'ready') {
      if (this.gatewayClientId) throw new Error('Duplicate Office event generation.')
      this.gatewayClientId = nonempty(frame.clientId)
      return { forward: { ...structuredClone(frame), clientId: this.clientToken } }
    }
    if (!this.gatewayClientId) throw new Error('Office event stream is not ready.')
    if (frame.type === 'waterfall') {
      const eventId = nonempty(frame.eventId)
      if (
        frame.agentId !== this.sessionId ||
        !['approval/request', 'user-questions/request'].includes(String(frame.event))
      ) {
        return {
          delegate: {
            args: { clientId: this.gatewayClientId, eventId, outcome: { kind: 'next' } },
          },
        }
      }
      if (this.deliveries.has(eventId) || this.deliveries.size >= 128) {
        throw new Error('Office event delivery limit or duplicate delivery.')
      }
      this.deliveries.set(eventId, String(frame.event))
      return { forward: structuredClone(frame) }
    }
    if (frame.type === 'cancel') {
      if (!this.deliveries.delete(nonempty(frame.eventId))) return {}
      return { forward: structuredClone(frame) }
    }
    if (frame.type === 'emit') {
      const args = Array.isArray(frame.args) ? frame.args : []
      const scoped = [
        'api-session/status',
        'api-session/activity',
        'api-session/error',
        'api-session/removed',
      ]
      if (scoped.includes(String(frame.event)) && args[0] === this.sessionId)
        return { forward: structuredClone(frame) }
      if (frame.event === 'llm/adapters-updated' && args.length === 0)
        return { forward: structuredClone(frame) }
    }
    return {}
  }

  /** Consume before awaiting Gateway dispatch so a concurrent duplicate cannot settle twice. */
  consume(input: unknown): RecordValue {
    if (this.closed || !this.gatewayClientId)
      throw new Error('Office event stream is closed or not ready.')
    const payload = record(input)
    exactKeys(payload, ['args'])
    const args = record(payload.args)
    exactKeys(args, ['clientId', 'eventId', 'outcome'])
    const eventId = nonempty(args.eventId)
    const event = this.deliveries.get(eventId)
    if (args.clientId !== this.clientToken || event === undefined) {
      throw new Error('This question was not delivered to this Office client.')
    }
    const outcome = record(args.outcome)
    if (typeof outcome.kind !== 'string' || !['next', 'result', 'rejected'].includes(outcome.kind))
      throw new Error('Invalid question answer outcome.')
    if (
      event === 'approval/request' &&
      outcome.kind === 'result' &&
      (typeof outcome.value !== 'string' ||
        !['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(outcome.value))
    ) {
      throw new Error('Invalid Office approval outcome.')
    }
    this.deliveries.delete(eventId)
    return { args: { ...structuredClone(args), clientId: this.gatewayClientId } }
  }

  close(): void {
    this.closed = true
    this.gatewayClientId = undefined
    this.deliveries.clear()
  }
}
