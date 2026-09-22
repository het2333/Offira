import { afterEach, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { HarnessSupervisor } from '../src/harness-supervisor'
import { startLocalHost, type RunningLocalHost } from '../src/server'

let running: RunningLocalHost | undefined
afterEach(async () => { await running?.close(); running = undefined; vi.restoreAllMocks() })

it('starts the bootstrap lifetime after runtime readiness, not before slow startup', async () => {
  let clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const ready = HarnessSupervisor.prototype.ready
  vi.spyOn(HarnessSupervisor.prototype, 'ready').mockImplementation(async function (this: HarnessSupervisor) {
    await ready.call(this)
    clock += 61_000
  })
  running = await startLocalHost({ runtimeCommand: {
    entry: fileURLToPath(new URL('./fixtures/fake-runtime.mjs', import.meta.url)),
  } })
  const first = await fetch(running.bootstrapUrl, { redirect: 'manual' })
  expect(first.status).toBe(303)
  expect((await fetch(running.bootstrapUrl, { redirect: 'manual' })).status).toBe(401)
})
