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
  for (const name of ['@nexusdesk/harness-office-panel-ui', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-tool', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-user-questions']) {
    assert.ok(ready.officeClientModules.includes(name), `Missing official module ${name}`)
  }
  assert.equal(ready.officeClientModules.includes('@deepseek-ai/dsh-client-ui-sidebar-terminal'), false)
  assert.ok(ready.toolCatalogs.sheets.includes('read_sheet'))
  assert.ok(!ready.toolCatalogs.sheets.includes('bash'))
  const credentialRef = 'OFFIRA_TEST_API_KEY'
  const emptyCredential = await exchange({ type: 'credential:request', protocolVersion: 1, id: 'credential-before', ref: credentialRef, action: 'describe' }, (frame) => frame.type === 'credential:result' && frame.id === 'credential-before')
  assert.equal(emptyCredential.info.configured, false)
  const savedCredential = await exchange({ type: 'credential:request', protocolVersion: 1, id: 'credential-set', ref: credentialRef, action: 'set', value: 'test-secret-never-returned' }, (frame) => frame.type === 'credential:result' && frame.id === 'credential-set')
  assert.equal(savedCredential.info.configured, true)
  assert.equal(savedCredential.info.writable, true)
  assert.equal(JSON.stringify(savedCredential).includes('test-secret-never-returned'), false)
  const removedCredential = await exchange({ type: 'credential:request', protocolVersion: 1, id: 'credential-unset', ref: credentialRef, action: 'unset' }, (frame) => frame.type === 'credential:result' && frame.id === 'credential-unset')
  assert.equal(removedCredential.info.configured, false)
  const bound = await exchange({ type: 'office:bind', protocolVersion: 1, id: 'bind-smoke', hostId: 'smoke', documentId: 'smoke-doc', clientId: 'smoke-client', editorType: 'sheets', revision: 0, cwd: root }, (frame) => frame.type === 'office:bound' && frame.id === 'bind-smoke')
  const catalog = await exchange({ type: 'office:client', protocolVersion: 1, id: 'catalog-smoke', sessionId: bound.sessionId, clientId: 'smoke-client', frame: { type: 'harness:rpc', protocolVersion: 1, id: 'catalog-smoke', documentId: 'smoke-doc', endpoint: 'session/modelCatalog', payload: { args: {} } } }, (frame) => frame.type === 'office:client-result' && frame.frame.id === 'catalog-smoke')
  assert.equal(catalog.frame.type, 'harness:result')
  assert.equal(catalog.frame.result.ok, true, 'Real official model catalog must be callable through the scoped carrier')
  const sessions = await exchange({ type: 'office:client', protocolVersion: 1, id: 'sessions-smoke', sessionId: bound.sessionId, clientId: 'smoke-client', frame: { type: 'harness:rpc', protocolVersion: 1, id: 'sessions-smoke', documentId: 'smoke-doc', endpoint: 'session/list', payload: { args: { _request: {} } } } }, (frame) => frame.type === 'office:client-result' && frame.frame.id === 'sessions-smoke')
  assert.equal(sessions.frame.type, 'harness:result')
  assert.equal(sessions.frame.result.ok, true)
  assert.deepEqual(sessions.frame.result.value.items.map((item) => item.sessionId), [bound.sessionId], 'Official client discovery must expose exactly its bound session')
  const events = await exchange({ type: 'office:client', protocolVersion: 1, id: 'events-smoke', sessionId: bound.sessionId, clientId: 'smoke-client', frame: { type: 'harness:stream-open', protocolVersion: 1, id: 'events-smoke', documentId: 'smoke-doc', endpoint: '$events', payload: { args: {} } } }, (frame) => frame.type === 'office:client-result' && frame.frame.id === 'events-smoke')
  assert.equal(events.frame.type, 'harness:stream-item', 'Real official event stream must open through the carrier')
  assert.equal(events.frame.value.type, 'ready')
  const settings = await exchange({ type: 'office:client', protocolVersion: 1, id: 'settings-smoke', sessionId: bound.sessionId, clientId: 'smoke-client', frame: { type: 'harness:rpc', protocolVersion: 1, id: 'settings-smoke', documentId: 'smoke-doc', endpoint: 'settings/describe', payload: { args: {} } } }, (frame) => frame.type === 'office:client-result' && frame.frame.id === 'settings-smoke')
  assert.equal(settings.frame.type, 'harness:result')
  assert.equal(settings.frame.result.ok, true)
  assert.equal(settings.frame.result.value.writable, false)
  const workspace = await exchange({ type: 'office:client', protocolVersion: 1, id: 'workspace-smoke', sessionId: bound.sessionId, clientId: 'smoke-client', frame: { type: 'harness:stream-open', protocolVersion: 1, id: 'workspace-smoke', documentId: 'smoke-doc', endpoint: 'workspace/follow', payload: { args: {} } } }, (frame) => frame.type === 'office:client-result' && frame.frame.id === 'workspace-smoke')
  assert.equal(workspace.frame.type, 'harness:stream-item')
  assert.equal(workspace.frame.value.type, 'baseline')
  process.stdout.write('Restricted Office Host graph and native model catalog passed. Browser activation remains a separate gate.\n')
} finally {
  if (child.connected) child.send({ type: 'shutdown', protocolVersion: 1, id: 'office-composition-shutdown' })
  const timer = setTimeout(() => child.kill('SIGTERM'), 5000)
  timer.unref()
  await new Promise((done) => { if (child.exitCode !== null) done(); else child.once('exit', done) })
  clearTimeout(timer)
}
