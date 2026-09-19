import {
  PROTOCOL_VERSION,
  type AgentEventFrame,
  type JsonValue,
  type SessionId,
} from '@nexusdesk/protocol'

import type { HarnessDurableEvent, HarnessStreamChunk } from './protocol'

const STREAM_FORWARD = new Set(['block-start', 'block-end', 'text-delta', 'tool-call-delta'])
const MAX_EVENT_TEXT = 16_384
const MAX_EVENT_JSON = 32_768

function toJsonValue(value: unknown, seen = new Set<object>()): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined
    seen.add(value)
    const array = value
      .map((entry) => toJsonValue(entry, seen))
      .filter((entry): entry is JsonValue => entry !== undefined)
    seen.delete(value)
    return array
  }
  if (typeof value !== 'object') return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  const projected: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    const json = toJsonValue(entry, seen)
    if (json !== undefined) projected[key] = json
  }
  seen.delete(value)
  return projected
}

function eventFrame(
  sessionId: string,
  type: string,
  data: JsonValue,
  seq?: number,
): AgentEventFrame {
  return {
    type: 'agent:event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: sessionId as SessionId,
    event: {
      type,
      ...(seq === undefined ? {} : { seq }),
      data,
    },
  }
}

/** Project a durable Harness event into JSON-only NexusDesk vocabulary. */
export function projectDurableEvent(
  sessionId: string,
  event: HarnessDurableEvent,
): AgentEventFrame | undefined {
  const data = recordOf(event.data)
  if (event.type === 'tool/call') {
    if (typeof data.callId !== 'string' || typeof data.name !== 'string') return undefined
    return eventFrame(
      sessionId,
      event.type,
      {
        callId: data.callId,
        name: data.name,
        arguments: boundedJson(data.arguments),
      },
      event.seq,
    )
  }
  if (event.type === 'tool/result') {
    const message = recordOf(data.message)
    const source = recordOf(message.source)
    const messageContent = Array.isArray(message.content) ? message.content : []
    const result = recordOf(messageContent[0])
    if (
      messageContent.length !== 1 ||
      result.type !== 'tool-result' ||
      typeof result.toolCallId !== 'string' ||
      source.kind !== 'tool' ||
      source.callId !== result.toolCallId
    ) {
      return undefined
    }
    return eventFrame(
      sessionId,
      event.type,
      {
        callId: result.toolCallId,
        isError: result.isError === true || Object.keys(recordOf(data.error)).length > 0,
        contentText: boundedText(textContent(result.content)),
      },
      event.seq,
    )
  }
  if (event.type === 'turn/end') {
    const reason = recordOf(data.reason)
    const error = recordOf(reason.error)
    return eventFrame(
      sessionId,
      event.type,
      {
        reason: {
          kind: typeof reason.kind === 'string' ? reason.kind : 'error',
          ...(typeof error.message === 'string'
            ? { error: { message: boundedText(error.message) } }
            : {}),
        },
      },
      event.seq,
    )
  }
  return undefined
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function boundedText(value: string): string {
  return value.length <= MAX_EVENT_TEXT ? value : `${value.slice(0, MAX_EVENT_TEXT - 1)}…`
}

function boundedJson(value: unknown): JsonValue {
  const json = toJsonValue(value) ?? null
  return JSON.stringify(json).length <= MAX_EVENT_JSON
    ? json
    : { omitted: 'tool arguments exceeded the NexusDesk event limit' }
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .flatMap((entry) => {
      const part = recordOf(entry)
      return typeof part.text === 'string' ? [part.text] : []
    })
    .join('\n')
}

/** Project only model output that the transcript is allowed to render. */
export function projectStreamChunk(
  sessionId: string,
  chunk: HarnessStreamChunk,
  openTextBlocks: Set<number>,
): AgentEventFrame | undefined {
  if (typeof chunk.index !== 'number' || !STREAM_FORWARD.has(chunk.type)) return undefined
  if (chunk.type === 'block-start') {
    if (chunk.blockType === 'text') openTextBlocks.add(chunk.index)
  } else if (chunk.type === 'block-end') {
    openTextBlocks.delete(chunk.index)
  } else if (chunk.type === 'text-delta' && !openTextBlocks.has(chunk.index)) {
    return undefined
  }
  const data: Record<string, JsonValue> = { type: chunk.type, index: chunk.index }
  if (typeof chunk.text === 'string') data.text = chunk.text
  if (typeof chunk.blockType === 'string') data.blockType = chunk.blockType
  if (typeof chunk.name === 'string') data.name = chunk.name
  return eventFrame(sessionId, 'stream/chunk', data)
}
