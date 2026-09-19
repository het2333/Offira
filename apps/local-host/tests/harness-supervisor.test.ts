import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { ClientId, DocumentId, Revision, SessionId } from '@nexusdesk/protocol'
import type { RuntimeResponseFrame } from '@nexusdesk/runtime-host/protocol'
import { HarnessSupervisor } from '../src/harness-supervisor'

const fixture = fileURLToPath(new URL('./fixtures/fake-runtime.mjs', import.meta.url))
let supervisor: HarnessSupervisor | undefined

afterEach(async () => {
  await supervisor?.shutdown()
  supervisor = undefined
})

function turn(prompt: string) {
  return {
    sessionId: 'session-1' as SessionId,
    documentId: 'document-1' as DocumentId,
    clientId: 'client-1' as ClientId,
    editorType: 'sheets',
    revision: 1 as Revision,
    cwd: join(process.cwd(), 'tests'),
    prompt,
  }
}

function collect(target: RuntimeResponseFrame[], predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('runtime event timed out')), 3_000)
    const interval = setInterval(() => {
      if (!predicate()) return
      clearTimeout(timeout)
      clearInterval(interval)
      resolve()
    }, 5)
    void target
  })
}

describe('HarnessSupervisor', () => {
  it('streams a normal turn and reports its terminal event', async () => {
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const frames: RuntimeResponseFrame[] = []
    supervisor.onFrame((frame) => frames.push(frame))
    await supervisor.ready()

    supervisor.startTurn(turn('hello'))
    await collect(frames, () =>
      frames.some((frame) => frame.type === 'agent:event' && frame.event.type === 'turn/end'),
    )

    expect(
      frames.some((frame) => frame.type === 'agent:event' && frame.event.type === 'stream/chunk'),
    ).toBe(true)
  })

  it('forwards cancellation and receives an aborted terminal event', async () => {
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const frames: RuntimeResponseFrame[] = []
    supervisor.onFrame((frame) => frames.push(frame))
    await supervisor.ready()
    supervisor.startTurn(turn('hello'))

    supervisor.cancelTurn('session-1' as SessionId)
    await collect(frames, () =>
      frames.some(
        (frame) =>
          frame.type === 'agent:event' &&
          frame.event.type === 'turn/end' &&
          (frame.event.data as { reason?: { kind?: string } })?.reason?.kind === 'aborted',
      ),
    )
  })

  it('restarts after a crash without replaying the active turn', async () => {
    supervisor = new HarnessSupervisor({ entry: fixture, restartDelayMs: 10 })
    const frames: RuntimeResponseFrame[] = []
    let readyCount = 0
    supervisor.onFrame((frame) => {
      frames.push(frame)
      if (frame.type === 'ready') readyCount += 1
    })
    await supervisor.ready()
    supervisor.startTurn(turn('crash'))

    await collect(frames, () => readyCount === 2)
    const starts = frames.filter(
      (frame) => frame.type === 'agent:event' && frame.event.type === 'test/start-received',
    )
    expect(starts).toHaveLength(1)
  })

  it('restarts after an unexpected idle crash with no active sessions', async () => {
    supervisor = new HarnessSupervisor({
      entry: fixture,
      args: ['idle-crash'],
      restartDelayMs: 10,
    })
    const frames: RuntimeResponseFrame[] = []
    const exits: Array<{ activeSessions: SessionId[] }> = []
    let readyCount = 0
    supervisor.onFrame((frame) => {
      frames.push(frame)
      if (frame.type === 'ready') readyCount += 1
    })
    supervisor.onExit((exit) => exits.push(exit))

    await collect(frames, () => readyCount === 2)

    expect(exits).toHaveLength(1)
    expect(exits[0]?.activeSessions).toEqual([])
  })
})
