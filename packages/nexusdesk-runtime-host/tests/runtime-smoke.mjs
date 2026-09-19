import { fork } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
child.on('message', (frame) => {
  if (frame?.type === 'ready') {
    ready = true
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
if (!ready || exit.code !== 0) {
  throw new Error(
    `runtime smoke failed: ready=${String(ready)} exit=${JSON.stringify(exit)} stderr=${stderr.join('')}`,
  )
}
