import { startLocalHost } from './server'

const running = await startLocalHost()
process.stdout.write(`${JSON.stringify({ bootstrapUrl: running.bootstrapUrl })}\n`)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void running.close().then(() => process.exit(0), (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
