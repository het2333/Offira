import { resolve } from 'node:path'

import { startLocalHost } from './server'

const repositoryRoot = process.cwd()
const runtimePackage = resolve(repositoryRoot, 'packages/nexusdesk-runtime-host')
const running = await startLocalHost({
  staticAssets: {
    webRoot: resolve(process.cwd(), 'apps/web/dist'),
    sheetsRoot: resolve(process.cwd(), 'apps/sheets/out/web'),
  },
  runtimeCommand: {
    entry: resolve(runtimePackage, 'lib/index.mjs'),
    args: [repositoryRoot, resolve(runtimePackage, 'profile'), 'runtime'],
  },
})
process.stdout.write(`${JSON.stringify({ bootstrapUrl: running.bootstrapUrl })}\n`)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void running.close().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
