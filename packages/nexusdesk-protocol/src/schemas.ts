import { z } from 'zod'

import type { AgentToolResult, JsonValue } from './editor'
import type { ClientFrame } from './frames'
import { PROTOCOL_VERSION } from './frames'
import { persistenceReferenceSchema } from './working-copy'

const nonEmptyString = z.string().min(1)
const revisionSchema = z.number().int().nonnegative()
const MAX_AGENT_DATA_BYTES = 256 * 1024
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

const mutationTargetSchema = z
  .object({
    sessionId: nonEmptyString,
    documentId: nonEmptyString,
    editorType: nonEmptyString,
    revision: revisionSchema,
    operationId: nonEmptyString,
    clientId: nonEmptyString,
  })
  .strict()

const agentIssueSchema = z
  .object({
    code: nonEmptyString,
    message: nonEmptyString,
    target: nonEmptyString.optional(),
  })
  .strict()

const agentToolResultSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string(),
    changes: z
      .object({
        targets: z.array(z.string()),
        count: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    warnings: z.array(agentIssueSchema),
    verification: z
      .object({
        passed: z.boolean(),
        issues: z.array(agentIssueSchema),
      })
      .strict()
      .optional(),
    continuation: z
      .object({
        suggestedTool: nonEmptyString.optional(),
        reason: nonEmptyString.optional(),
      })
      .strict()
      .optional(),
    transactionId: nonEmptyString.optional(),
    data: jsonValueSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.data === undefined) return
    if (new TextEncoder().encode(JSON.stringify(result.data)).byteLength > MAX_AGENT_DATA_BYTES) {
      context.addIssue({
        code: 'custom',
        path: ['data'],
        message: `agent result data exceeds ${String(MAX_AGENT_DATA_BYTES)} bytes`,
      })
    }
  })

const frameBase = { protocolVersion: z.literal(PROTOCOL_VERSION) }

const clientFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...frameBase,
      type: z.literal('agent:start'),
      id: nonEmptyString,
      sessionId: nonEmptyString,
      documentId: nonEmptyString,
      prompt: z.string().min(1),
      provider: nonEmptyString.optional(),
      model: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal('agent:cancel'),
      id: nonEmptyString,
      sessionId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal('approval:response'),
      id: nonEmptyString,
      outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal('editor:register'),
      id: nonEmptyString,
      clientId: nonEmptyString,
      rendererInstanceId: nonEmptyString,
      documentId: nonEmptyString,
      editorType: nonEmptyString,
      revision: revisionSchema,
      editorSessionId: z.string().min(1).max(256).optional(),
      documentEpoch: nonEmptyString.optional(),
      sourceContentId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      restoredCheckpointId: nonEmptyString.nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal('editor:revision'),
      id: nonEmptyString,
      clientId: nonEmptyString,
      documentId: nonEmptyString,
      revision: revisionSchema,
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal('editor:detach'),
      id: nonEmptyString,
      clientId: nonEmptyString,
      documentId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal('editor:result'),
      id: nonEmptyString,
      target: mutationTargetSchema,
      result: agentToolResultSchema,
      persistence: persistenceReferenceSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal('operation:lookup'),
      id: nonEmptyString,
      operationId: nonEmptyString,
      documentId: nonEmptyString.optional(),
      documentEpoch: nonEmptyString.optional(),
      requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
    .strict(),
]).superRefine((frame, context) => {
  const fields = frame.type === 'editor:register'
    ? [frame.documentEpoch, frame.sourceContentId, frame.restoredCheckpointId]
    : frame.type === 'operation:lookup'
      ? [frame.documentId, frame.documentEpoch, frame.requestFingerprint] : []
  if (fields.some((field) => field !== undefined) && fields.some((field) => field === undefined)) {
    context.addIssue({ code: 'custom', message: 'Working-copy identity fields must be supplied together.' })
  }
})

/** Parse one untrusted browser frame and reject unknown fields. */
export function parseClientFrame(value: unknown): ClientFrame {
  return clientFrameSchema.parse(value) as ClientFrame
}

/** Parse the bounded result vocabulary exposed to an agent. */
export function parseAgentToolResult(value: unknown): AgentToolResult {
  return agentToolResultSchema.parse(value) as AgentToolResult
}
