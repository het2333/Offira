import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const runtime = resolve(root, 'packages/nexusdesk-runtime-host')
const child = fork(resolve(runtime, 'lib/index.mjs'), [root, resolve(runtime, 'profile'), 'runtime'], {
  execArgv: ['--expose-internals'],
  env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
})
let errors = ''
child.stderr.on('data', (data) => { errors = (errors + String(data)).slice(-4000) })
function exchange(frame, accepts) {
  return new Promise((resolveReply, reject) => {
    const cleanup = () => { clearTimeout(timeout); child.off('message', listener) }
    const listener = (reply) => {
      if (reply.type === 'fatal') { cleanup(); reject(new Error(reply.message)) }
      else if (accepts(reply)) { cleanup(); resolveReply(reply) }
    }
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Office smoke timed out at ${frame.type}`)) }, 15000)
    child.on('message', listener)
    child.send(frame)
  })
}
try {
  const ready = await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Office profile did not become ready within 45 seconds.')), 45_000)
    child.on('message', (frame) => {
      if (frame.type === 'ready') { clearTimeout(timeout); resolveReady(frame) }
      if (frame.type === 'fatal') { clearTimeout(timeout); reject(new Error(frame.message)) }
    })
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Runtime exited ${code}: ${errors}`)) })
  })
  assert.ok(Array.isArray(ready.officeClientModules), 'Runtime must publish the real Office client graph')
  for (const name of ['@nexusdesk/harness-office-panel-ui', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-user-questions']) {
    assert.ok(ready.officeClientModules.includes(name), `Missing official module ${name}`)
  }
  assert.equal(ready.officeClientModules.includes('@deepseek-ai/dsh-client-ui-sidebar-terminal'), false)
  assert.ok(ready.toolCatalogs.sheets.includes('read_sheet'))
  assert.ok(!ready.toolCatalogs.sheets.includes('bash'))
  const bound = await exchange({ type: 'office:bind', protocolVersion: 1, id: 'bind-smoke', hostId: 'smoke', documentId: 'smoke-doc', clientId: 'smoke-client', editorType: 'sheets', revision: 0, cwd: root }, (frame) => frame.type === 'office:bound' && frame.id === 'bind-smoke')
  const catalog = await exchange({ type: 'office:client', protocolVersion: 1, id: 'catalog-smoke', sessionId: bound.sessionId, clientId: 'smoke-client', frame: { type: 'harness:rpc', protocolVersion: 1, id: 'catalog-smoke', documentId: 'smoke-doc', endpoint: 'session/modelCatalog', payload: { args: {} } } }, (frame) => frame.type === 'office:client-result' && frame.frame.id === 'catalog-smoke')
  assert.equal(catalog.frame.type, 'harness:result')
  assert.equal(catalog.frame.result.ok, true, 'Real official model catalog must be callable through the scoped carrier')
  process.stdout.write('Restricted Office Host graph and native model catalog passed. Browser activation remains a separate gate.\n')
} finally {
  if (child.connected) child.send({ type: 'shutdown', protocolVersion: 1, id: 'office-composition-shutdown' })
  const timer = setTimeout(() => child.kill('SIGTERM'), 5000)
  timer.unref()
  await new Promise((done) => { if (child.exitCode !== null) done(); else child.once('exit', done) })
  clearTimeout(timer)
}
