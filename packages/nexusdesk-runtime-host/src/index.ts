import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {
  AgentToolResult,
  AgentApprovalProposal,
  ApprovalOutcome,
  JsonValue,
  OperationId,
  SessionId,
} from '@nexusdesk/protocol'

import { projectDurableEvent, projectStreamChunk } from './projection'
import {
  configureOfficeToolScope,
  DOCS_TOOL_NAMES,
  HTML_TOOL_NAMES,
  MARKDOWN_TOOL_NAMES,
  PDF_TOOL_NAMES,
  SHEETS_TOOL_NAMES,
  SLIDES_TOOL_NAMES,
} from './runtime-policy'
import { createDocsTools, type DocsToolBridge } from './docs-tools'
import { createMarkdownTools } from './markdown-tools'
import { createHtmlTools } from './html-tools'
import { createPdfTools } from './pdf-tools'
import { createSheetsTools } from './sheets-tools'
import { createSlidesTools } from './slides-tools'
import {
  PROTOCOL_VERSION,
  validateRuntimeEditorResponse,
  type HarnessDurableEvent,
  type HarnessStreamChunk,
  type RuntimeRequestFrame,
  type RuntimeResponseFrame,
} from './protocol'

interface AgentHandle {
  agent: {
    followup(message: unknown): void
    cancel(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
  }
  dispose(): Promise<void>
}

interface RuntimeContext {
  agentDefaultModel: {
    currentSelection(): { provider: string; model: string; reasoningEffort?: string }
  }
  agents: {
    create(options: unknown): Promise<unknown>
  }
  profileContext: {
    startedBundles: unknown
  }
  tools: {
    register(tool: import('@deepseek-ai/dsh-tools').ToolDefinition): () => void
  }
  approval: {
    request(input: {
      agent: unknown
      toolName: string
      callId?: unknown
      reason?: string
      signal?: AbortSignal
    }): Promise<ApprovalOutcome>
  }
  on(
    event: 'approval/request',
    listener: (request: {
      toolName: string
      reason?: string
      agent?: { session?: { id?: unknown } }
    }) => Promise<ApprovalOutcome>,
  ): void
  on(
    event: 'session/event',
    listener: (session: { id: unknown }, event: HarnessDurableEvent) => void,
  ): void
  on(
    event: 'agent/assistant-stream',
    listener: (payload: {
      agent: { session: { id: string } }
      frame: { chunk?: HarnessStreamChunk }
    }) => void,
  ): void
}

function asRuntimeContext(value: unknown): RuntimeContext {
  return value as RuntimeContext
}

const [runtimeDir = '', profileDir = '', mode = 'runtime', ...patchFiles] = process.argv.slice(2)
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
// The product runtime never composes the user's general-purpose Harness patch.
// Provider selection remains available through the pinned base profile and
// inherited provider environment, while plugin/tool composition is app-owned.
const runtimeStateDir = mkdtempSync(join(tmpdir(), 'nexusdesk-runtime-'))
process.env.DSH_HOME = runtimeStateDir
process.once('exit', () => rmSync(runtimeStateDir, { recursive: true, force: true }))

function send(frame: RuntimeResponseFrame): void {
  if (!process.connected || process.send === undefined) return
  process.send(frame, (error) => {
    if (error !== null) process.stderr.write(`[runtime-host] IPC send failed: ${error.message}\n`)
  })
}

const replies = new Map<string, (frame: RuntimeRequestFrame) => void>()
const agents = new Map<string, AgentHandle>()
const editorTargets = new Map<
  string,
  {
    sessionId: SessionId
    documentId: import('@nexusdesk/protocol').DocumentId
    clientId: import('@nexusdesk/protocol').ClientId
    editorType: string
    revision: import('@nexusdesk/protocol').Revision
  }
>()
const textBlocks = new Map<string, Set<number>>()
let stopping: Promise<void> | undefined
let disposeOfficeTools: Array<() => void> = []

process.on('message', (frame: RuntimeRequestFrame) => {
  if (frame.protocolVersion !== PROTOCOL_VERSION && frame.type !== 'shutdown') {
    send({
      type: 'fatal',
      protocolVersion: PROTOCOL_VERSION,
      message: 'runtime protocol version mismatch',
    })
    process.exitCode = 1
    return
  }
  if (frame.type === 'approval:response' || frame.type === 'editor:result') {
    replies.get(frame.id)?.(frame)
    replies.delete(frame.id)
    return
  }
  void handle(frame).catch((error: unknown) => {
    send({
      type: 'fatal',
      protocolVersion: PROTOCOL_VERSION,
      message: error instanceof Error ? error.message : String(error),
    })
  })
})

type ParentRequest =
  | Omit<Extract<RuntimeResponseFrame, { type: 'approval:request' }>, 'id' | 'protocolVersion'>
  | Omit<Extract<RuntimeResponseFrame, { type: 'editor:request' }>, 'id' | 'protocolVersion'>

function requestParent(frame: ParentRequest, timeoutMs = 120_000): Promise<RuntimeRequestFrame> {
  const id = `request-${randomUUID()}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      replies.delete(id)
      reject(new Error(`approval request timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    replies.set(id, (reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
    send({ ...frame, protocolVersion: PROTOCOL_VERSION, id } as RuntimeResponseFrame)
  })
}

function requestParentTracked(
  frame: ParentRequest,
  timeoutMs = 120_000,
): { id: string; reply: Promise<RuntimeRequestFrame> } {
  const id = `request-${randomUUID()}`
  return {
    id,
    reply: new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        replies.delete(id)
        reject(new Error(`parent request timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      replies.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      send({ ...frame, protocolVersion: PROTOCOL_VERSION, id } as RuntimeResponseFrame)
    }),
  }
}

const boot = runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: basename(profileDir),
  resolutionMode: mode === 'link' ? 'link' : 'runtime',
  resolvedProfile: {
    profile: loadProfileDirectory('dsh', profileDir, installAnchor),
    installAnchor,
  },
  patchFiles,
  args: [],
})

async function openAgent(
  frame: Extract<RuntimeRequestFrame, { type: 'agent:start' }>,
): Promise<AgentHandle> {
  const existing = agents.get(frame.sessionId)
  if (existing !== undefined) return existing
  const ctx = asRuntimeContext((await boot).ctx)
  const agentOptions = frame.provider !== undefined && frame.model !== undefined
    ? { provider: frame.provider, model: frame.model }
    : ctx.agentDefaultModel.currentSelection()
  const created = (await ctx.agents.create({
    sessionId: brandString(frame.sessionId),
    meta: { cwd: frame.cwd },
    agentOptions,
    setup(
      agentContext: { tools: Parameters<typeof configureOfficeToolScope>[0]['tools'] },
      agent: object,
    ) {
      configureOfficeToolScope({ tools: agentContext.tools }, frame.editorType, agent)
    },
  })) as AgentHandle
  agents.set(frame.sessionId, created)
  return created
}

async function handle(frame: RuntimeRequestFrame): Promise<void> {
  switch (frame.type) {
    case 'agent:start': {
      editorTargets.set(frame.sessionId, {
        sessionId: frame.sessionId,
        documentId: frame.documentId,
        clientId: frame.clientId,
        editorType: frame.editorType,
        revision: frame.revision,
      })
      const handle = await openAgent(frame)
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: frame.prompt }],
          source: { kind: 'user' },
        }),
      )
      return
    }
    case 'agent:cancel':
      agents.get(frame.sessionId)?.agent.cancel({ kind: 'user' }, { keepInbox: true })
      return
    case 'shutdown':
      await stop()
      return
    case 'approval:response':
    case 'editor:result':
      return
  }
}

const stop = (): Promise<void> =>
  (stopping ??= (async () => {
    const running = await boot.catch(() => undefined)
    for (const handle of agents.values()) await handle.dispose().catch(() => undefined)
    agents.clear()
    editorTargets.clear()
    for (const dispose of disposeOfficeTools.splice(0)) dispose()
    await running?.shutdown.shutdown(0)
    send({ type: 'shutdown-complete', protocolVersion: PROTOCOL_VERSION })
    if (process.connected) process.disconnect()
  })())

process.once('disconnect', () => {
  void stop()
})

const ctx = asRuntimeContext((await boot).ctx)

function createEditorToolBridge(
  editorType: 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html',
): DocsToolBridge {
  return {
    async request(command, arguments_, execution, authorization): Promise<AgentToolResult> {
      const sessionId = String(execution.agent?.id ?? '')
      const target = editorTargets.get(sessionId)
      if (target === undefined) {
        throw new Error(`no ${editorType} editor is bound to this agent session`)
      }
      if (target.editorType !== editorType) {
        throw new Error(
          `agent session is bound to ${target.editorType}, not the requested ${editorType} editor`,
        )
      }
      // Provider call ids are not globally unique. Bind them to the durable
      // document/tool scope, excluding session, client and revision so an
      // invocation retried after reconnect still reaches its journal entry.
      const operationId = (authorization?.operationId ?? `operation-${createHash('sha256')
        .update(JSON.stringify([target.documentId, editorType, execution.name, String(execution.callId)]))
        .digest('hex')}`) as OperationId
      const reply = await requestParent({
        type: 'editor:request',
        target: { ...target, operationId },
        command,
        arguments: arguments_ as JsonValue,
        ...(authorization === undefined
          ? {}
          : {
              approval: {
                id: authorization.approvalId as import('@nexusdesk/protocol').RequestId,
                planHash: authorization.planHash,
              },
            }),
      })
      if (reply.type !== 'editor:result' || reply.target.operationId !== operationId) {
        throw new Error(`${editorType} editor returned a mismatched operation result`)
      }
      validateRuntimeEditorResponse(reply)
      target.revision = reply.currentRevision
      return reply.result
    },
    async approve(toolName, proposal: AgentApprovalProposal, execution) {
      if (execution.agent === undefined) return { approved: false }
      const sessionId = String(execution.agent.id ?? '') as SessionId
      const pending = requestParentTracked({
        type: 'approval:request',
        sessionId,
        toolName,
        reason: proposal.summary,
        proposal,
      })
      const reply = await pending.reply
      return reply.type === 'approval:response' && reply.outcome === 'allowed-once'
        ? { approved: true, approvalId: pending.id }
        : { approved: false }
    },
  }
}

disposeOfficeTools = [
  ...createSheetsTools(createEditorToolBridge('sheets')),
  ...createDocsTools(createEditorToolBridge('docs')),
  ...createPdfTools(createEditorToolBridge('pdf')),
  ...createMarkdownTools(createEditorToolBridge('markdown')),
  ...createHtmlTools(createEditorToolBridge('html')),
  ...createSlidesTools(createEditorToolBridge('slides')),
].map((tool) => ctx.tools.register(tool))

ctx.on(
  'approval/request',
  (request: { toolName: string; reason?: string; agent?: { session?: { id?: unknown } } }) => {
    const sessionId = String(
      request.agent?.session?.id ?? agents.keys().next().value ?? '',
    ) as SessionId
    return requestParent({
      type: 'approval:request',
      sessionId,
      toolName: request.toolName,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    }).then((reply) =>
      reply.type === 'approval:response' ? reply.outcome : 'unavailable',
    ) as Promise<ApprovalOutcome>
  },
)

ctx.on('session/event', (session: { id: unknown }, event: HarnessDurableEvent) => {
  const projected = projectDurableEvent(String(session.id), event)
  if (projected !== undefined) send(projected)
})

ctx.on(
  'agent/assistant-stream',
  (payload: { agent: { session: { id: string } }; frame: { chunk?: HarnessStreamChunk } }) => {
    const chunk = payload.frame.chunk
    if (chunk === undefined) return
    const open = textBlocks.get(payload.agent.session.id) ?? new Set<number>()
    textBlocks.set(payload.agent.session.id, open)
    const projected = projectStreamChunk(payload.agent.session.id, chunk, open)
    if (projected !== undefined) send(projected)
  },
)

send({
  type: 'ready',
  protocolVersion: PROTOCOL_VERSION,
  pid: process.pid,
  startedBundles: ctx.profileContext.startedBundles as string[],
  toolCatalogs: {
    docs: DOCS_TOOL_NAMES,
    sheets: SHEETS_TOOL_NAMES,
    slides: SLIDES_TOOL_NAMES,
    pdf: PDF_TOOL_NAMES,
    markdown: MARKDOWN_TOOL_NAMES,
    html: HTML_TOOL_NAMES,
  },
})
