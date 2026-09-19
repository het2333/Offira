import {
  PROTOCOL_VERSION,
  type AgentEventFrame,
  type JsonValue,
  type SessionId,
} from '@nexusdesk/protocol'

import type { HarnessDurableEvent, HarnessStreamChunk } from './protocol'

const STREAM_FORWARD = new Set(['block-start', 'block-end', 'text-delta', 'tool-call-delta'])

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
): AgentEventFrame {
  return eventFrame(sessionId, event.type, toJsonValue(event.data) ?? null, event.seq)
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
