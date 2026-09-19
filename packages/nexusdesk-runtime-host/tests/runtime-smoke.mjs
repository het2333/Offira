import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const repositoryRoot = join(packageRoot, '..', '..')
const protocolVersion = 1
const toolCalls = [
  { id: 'smoke-read-call', name: 'read_presentation', arguments: {} },
  {
    id: 'smoke-apply-call',
    name: 'apply_presentation_operations',
    arguments: {
      operations: [{
        op: 'setText', target: { slide: 0, el: 'sp_0' },
        paragraphs: [{ runs: [{ text: 'Edited by production runtime' }] }],
      }],
    },
  },
  { id: 'smoke-save-call', name: 'save_presentation', arguments: {} },
]

function fail(message) {
  throw new Error(`runtime smoke failed: ${message}`)
}

function json(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function completion(response, delta, finishReason) {
  json(response, {
    id: 'smoke-completion', object: 'chat.completion.chunk', created: 0, model: 'smoke-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
  response.end('data: [DONE]\n\n')
}

const providerRequests = []
let agentStep = 0
const provider = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  providerRequests.push(body)
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const tools = Array.isArray(body.tools) ? body.tools : []
  const officeTurn = tools.some((tool) => tool?.function?.name === 'read_presentation')
  if (!officeTurn) {
    completion(response, { role: 'assistant', content: 'Smoke title' }, 'stop')
    return
  }
  const call = toolCalls[agentStep]
  agentStep += 1
  if (call === undefined) {
    completion(response, { role: 'assistant', content: 'Presentation saved.' }, 'stop')
    return
  }
  completion(response, {
    role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
  }, 'tool_calls')
})

await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
const address = provider.address()
if (address === null || typeof address === 'string') fail('could not allocate the local fake provider port')

const stateDir = mkdtempSync(join(tmpdir(), 'nexusdesk-runtime-smoke-'))
const patchFile = join(stateDir, 'smoke-provider.patch.yml')
writeFileSync(patchFile, `- id: llm-pi-ai
  config:
    providers:
      smoke:
        displayName: Smoke
        api: openai-completions
        baseURL: http://127.0.0.1:${String(address.port)}/v1
        apiKeyEnv: NEXUSD_SMOKE_API_KEY
        models:
          - id: smoke-model
            name: Smoke model
            contextWindow: 32768
            maxTokens: 1024
- id: agent-default-model
  config:
    provider: smoke
    model: smoke-model
`)

const child = fork(
  join(packageRoot, 'lib/index.mjs'),
  [repositoryRoot, join(packageRoot, 'profile'), 'runtime', patchFile],
  {
    execArgv: ['--expose-internals'],
    env: { ...process.env, NEXUSD_SMOKE_API_KEY: 'smoke' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  },
)
const stderr = []
child.stderr?.setEncoding('utf8')
child.stderr?.on('data', (chunk) => stderr.push(chunk))

const editorFrames = []
const approvalFrames = []
let ready = false
let completed = false
let fatal
let toolCatalogs
const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000)

function responseFor(frame) {
  const operationId = frame.target.operationId
  if (frame.command === 'read_presentation') {
    return { ok: true, summary: 'Read presentation.', warnings: [], data: { contentVersion: 1, slides: [{ nodes: [{ sourceId: 'sp_0', type: 'text' }] }] } }
  }
  if (frame.command === 'propose_ops') return { ok: true, summary: 'Apply title edit.', warnings: [], data: { operationId, planHash: 'apply-plan', summary: 'Apply title edit.', targets: ['sp_0'] } }
  if (frame.command === 'apply_ops') return { ok: true, summary: 'Applied title edit.', warnings: [], data: { contentVersion: 2 } }
  if (frame.command === 'propose_save') return { ok: true, summary: 'Save current presentation.', warnings: [], data: { operationId, planHash: 'save-plan', contentVersion: 2, summary: 'Save current presentation.', targets: ['current presentation'] } }
  if (frame.command === 'save_presentation') return { ok: true, summary: 'Saved presentation.', warnings: [] }
  fail(`unexpected editor command ${frame.command}`)
}

child.on('message', (frame) => {
  if (frame?.type === 'ready') {
    ready = true
    toolCatalogs = frame.toolCatalogs
    child.send({
      type: 'agent:start', protocolVersion, id: 'smoke-start', sessionId: 'smoke-session', documentId: 'smoke-document', clientId: 'smoke-client',
      editorType: 'slides', revision: 1, cwd: repositoryRoot, prompt: 'Apply the title change and save it.',
    })
    return
  }
  if (frame?.type === 'fatal') {
    fatal = frame.message
    child.send({ type: 'shutdown', protocolVersion, id: 'smoke-shutdown' })
    return
  }
  if (frame?.type === 'approval:request') {
    approvalFrames.push(frame)
    child.send({ type: 'approval:response', protocolVersion, id: frame.id, outcome: 'allowed-once' })
    return
  }
  if (frame?.type === 'editor:request') {
    editorFrames.push(frame)
    child.send({ type: 'editor:result', protocolVersion, id: frame.id, target: frame.target, currentRevision: 1, result: responseFor(frame) })
    return
  }
  if (frame?.type === 'agent:event' && frame.event?.type === 'turn/end') {
    completed = true
    child.send({ type: 'shutdown', protocolVersion, id: 'smoke-shutdown' })
  }
})

const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
clearTimeout(timeout)
await new Promise((resolve) => provider.close(resolve))
rmSync(stateDir, { recursive: true, force: true })

const expectedCatalogs = {
  docs: ['read_document', 'apply_document_operations', 'save_document'],
  sheets: ['read_sheet', 'apply_sheet_operations', 'save_sheet'],
  slides: [
    'read_presentation',
    'apply_presentation_operations',
    'save_presentation',
    'undo_presentation',
    'redo_presentation',
  ],
  pdf: ['read_pdf', 'apply_pdf_operations', 'save_pdf'],
  markdown: ['read_markdown', 'apply_markdown_operations', 'save_markdown'],
  html: ['read_html', 'apply_html_operations', 'save_html'],
}
const commands = editorFrames.map((frame) => frame.command)
const expectedCommands = ['read_presentation', 'propose_ops', 'apply_ops', 'propose_save', 'save_presentation']
if (
  fatal !== undefined ||
  !ready ||
  !completed ||
  exit.code !== 0 ||
  JSON.stringify(toolCatalogs) !== JSON.stringify(expectedCatalogs) ||
  JSON.stringify(commands) !== JSON.stringify(expectedCommands)
) {
  fail(
    `ready=${String(ready)} completed=${String(completed)} fatal=${String(fatal)} catalogs=${JSON.stringify(toolCatalogs)} exit=${JSON.stringify(exit)} commands=${JSON.stringify(commands)} stderr=${stderr.join('')}`,
  )
}
if (providerRequests.length < 5 || agentStep !== 4) fail(`local provider did not complete the tool sequence (${String(providerRequests.length)} requests, ${String(agentStep)} calls)`)
if (approvalFrames.length !== 2 || approvalFrames[0]?.toolName !== 'apply_presentation_operations' || approvalFrames[1]?.toolName !== 'save_presentation') fail(`approval chain=${JSON.stringify(approvalFrames)}`)
const [read, propose, apply, proposeSave, save] = editorFrames
if (
  read?.target.operationId !== 'operation-smoke-read-call' ||
  propose?.target.operationId !== 'operation-smoke-apply-call' ||
  apply?.target.operationId !== 'operation-smoke-apply-call' ||
  proposeSave?.target.operationId !== 'operation-smoke-save-call' ||
  save?.target.operationId !== 'operation-smoke-save-call' ||
  JSON.stringify(apply?.arguments) !== JSON.stringify({ ops: toolCalls[1].arguments.operations }) ||
  JSON.stringify(save?.arguments) !== JSON.stringify({ inPlace: true, contentVersion: 2 }) ||
  apply?.approval?.planHash !== 'apply-plan' ||
  save?.approval?.planHash !== 'save-plan' ||
  apply?.approval?.id !== approvalFrames[0]?.id ||
  save?.approval?.id !== approvalFrames[1]?.id
) fail(`proposal/approval/apply/save arguments were not preserved: ${JSON.stringify(editorFrames)}`)
