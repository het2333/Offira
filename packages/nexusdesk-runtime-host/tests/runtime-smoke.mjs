import { fork } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { createSlidesTools } = await import('../lib/slides-tools.mjs')

const bridgeCalls = []
const saveProposal = {
  ok: true,
  summary: 'Save the current presentation in place.',
  warnings: [],
  data: {
    operationId: 'save-op',
    planHash: 'save-plan-hash',
    contentVersion: 7,
    summary: 'Save the current presentation in place.',
    targets: ['current presentation'],
  },
}
const saved = { ok: true, summary: 'Saved the current presentation in place.', warnings: [] }
const directTools = createSlidesTools({
  async request(command, arguments_, _execution, authorization) {
    bridgeCalls.push({ command, arguments_, authorization })
    return command === 'propose_save' ? saveProposal : saved
  },
  async approve() { return { approved: true, approvalId: 'approval-1' } },
})
const directSave = directTools.find((tool) => tool.name === 'save_presentation')
if (directSave === undefined) throw new Error('runtime smoke could not find save_presentation')
const directResult = await directSave.execute({}, { signal: new AbortController().signal })
if (
  JSON.stringify(directResult) !== JSON.stringify(saved) ||
  JSON.stringify(bridgeCalls) !== JSON.stringify([
    { command: 'propose_save', arguments_: {} },
    {
      command: 'save_presentation',
      arguments_: { inPlace: true, contentVersion: 7 },
      authorization: { approvalId: 'approval-1', planHash: 'save-plan-hash', operationId: 'save-op' },
    },
  ])
) {
  throw new Error(`direct Slides tools smoke failed: result=${JSON.stringify(directResult)} calls=${JSON.stringify(bridgeCalls)}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const repositoryRoot = join(packageRoot, '..', '..')
const hostileUserHome = mkdtempSync(join(tmpdir(), 'nexusdesk-hostile-dsh-home-'))
writeFileSync(join(hostileUserHome, 'cordis.patch.yml'), 'not: [valid')
const child = fork(
  join(packageRoot, 'lib/index.mjs'),
  [repositoryRoot, join(packageRoot, 'profile'), 'runtime'],
  {
    execArgv: ['--expose-internals'],
    env: { ...process.env, DSH_HOME: hostileUserHome },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  },
)

const stderr = []
child.stderr?.setEncoding('utf8')
child.stderr?.on('data', (chunk) => stderr.push(chunk))

const timeout = setTimeout(() => {
  child.kill('SIGKILL')
  throw new Error(`runtime smoke timed out: ${stderr.join('')}`)
}, 30_000)

let ready = false
let toolCatalogs
child.on('message', (frame) => {
  if (frame?.type === 'ready') {
    ready = true
    toolCatalogs = frame.toolCatalogs
    child.send({ type: 'shutdown', protocolVersion: 1, id: 'shutdown-smoke' })
  } else if (frame?.type === 'shutdown-complete') {
    clearTimeout(timeout)
    child.disconnect()
  }
})

const exit = await new Promise((resolve) =>
  child.once('exit', (code, signal) => resolve({ code, signal })),
)
clearTimeout(timeout)
rmSync(hostileUserHome, { recursive: true, force: true })
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
  markdown: ['read_markdown', 'apply_markdown_operations', 'save_markdown'],
  html: ['read_html', 'apply_html_operations', 'save_html'],
}
if (
  !ready ||
  exit.code !== 0 ||
  JSON.stringify(toolCatalogs) !== JSON.stringify(expectedCatalogs)
) {
  throw new Error(
    `runtime smoke failed: ready=${String(ready)} catalogs=${JSON.stringify(toolCatalogs)} exit=${JSON.stringify(exit)} stderr=${stderr.join('')}`,
  )
}
