import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import type { Revision } from '@nexusdesk/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OfficeSessionBindingStore,
  acquireOfficeAgent,
  freezeOfficeTurnContext,
  officeTurnContextText,
} from '../src/office-session-binding'

const directories: string[] = []
const execFileAsync = promisify(execFile)
const bindingModuleUrl = pathToFileURL(
  fileURLToPath(new URL('../src/office-session-binding.ts', import.meta.url)),
).href

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexusdesk-office-session-test-'))
  directories.push(directory)
  return directory
}

async function installBindingLock(
  directory: string,
  owner: { token: string; pid: number },
): Promise<void> {
  const lockDirectory = join(directory, '.office-session-bindings.lock')
  await mkdir(lockDirectory, { mode: 0o700 })
  await writeFile(
    join(lockDirectory, 'owner.json'),
    `${JSON.stringify({ version: 1, ...owner })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

async function bindFromIndependentRuntime(
  directory: string,
  documentId: string,
  sessionId: string,
  ownReadyFile: string,
  otherReadyFile: string,
): Promise<string> {
  const script = `
    import { existsSync, writeFileSync } from 'node:fs'
    import { OfficeSessionBindingStore } from ${JSON.stringify(bindingModuleUrl)}
    const waitArray = new Int32Array(new SharedArrayBuffer(4))
    const store = new OfficeSessionBindingStore(
      process.env.NEXUSDESK_TEST_STATE_DIRECTORY,
      () => {
        writeFileSync(process.env.NEXUSDESK_TEST_OWN_READY, '')
        const deadline = Date.now() + 250
        while (Date.now() < deadline && !existsSync(process.env.NEXUSDESK_TEST_OTHER_READY)) {
          Atomics.wait(waitArray, 0, 0, 5)
        }
        return process.env.NEXUSDESK_TEST_SESSION_ID
      },
    )
    process.stdout.write(await store.bindOfficeSession('host-a', process.env.NEXUSDESK_TEST_DOCUMENT_ID))
  `
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        NEXUSDESK_TEST_STATE_DIRECTORY: directory,
        NEXUSDESK_TEST_DOCUMENT_ID: documentId,
        NEXUSDESK_TEST_SESSION_ID: sessionId,
        NEXUSDESK_TEST_OWN_READY: ownReadyFile,
        NEXUSDESK_TEST_OTHER_READY: otherReadyFile,
      },
    },
  )
  return stdout
}

describe('OfficeSessionBindingStore', () => {
  it('returns the same durable session after a runtime restart', async () => {
    const directory = await stateDirectory()
    const ids = ['office-session-1', 'office-session-2']
    const first = new OfficeSessionBindingStore(directory, () => ids.shift()!)
    const sessionId = await first.bindOfficeSession('host-a', 'document-a')

    const restarted = new OfficeSessionBindingStore(directory, () => ids.shift()!)

    expect(await restarted.bindOfficeSession('host-a', 'document-a')).toBe(sessionId)
    expect(ids).toEqual(['office-session-2'])
  })

  it('isolates documents, Hosts, and concurrent first binds', async () => {
    const directory = await stateDirectory()
    let next = 0
    const store = new OfficeSessionBindingStore(directory, () => `office-session-${++next}`)

    const [sameA, sameB, otherDocument, otherHost] = await Promise.all([
      store.bindOfficeSession('host-a', 'document-a'),
      store.bindOfficeSession('host-a', 'document-a'),
      store.bindOfficeSession('host-a', 'document-b'),
      store.bindOfficeSession('host-b', 'document-a'),
    ])

    expect(sameA).toBe(sameB)
    expect(new Set([sameA, otherDocument, otherHost])).toHaveLength(3)
    expect(next).toBe(3)
    const persisted = JSON.parse(await readFile(join(directory, 'office-session-bindings.json'), 'utf8'))
    expect(persisted.bindings).toHaveLength(3)
  })

  it('preserves concurrent bindings created by independent runtime processes', async () => {
    const directory = await stateDirectory()
    const readyA = join(directory, 'runtime-a.ready')
    const readyB = join(directory, 'runtime-b.ready')

    const [sessionA, sessionB] = await Promise.all([
      bindFromIndependentRuntime(
        directory, 'document-a', 'office-session-a', readyA, readyB,
      ),
      bindFromIndependentRuntime(
        directory, 'document-b', 'office-session-b', readyB, readyA,
      ),
    ])

    const restarted = new OfficeSessionBindingStore(directory, () => 'unexpected-session')
    expect(await restarted.bindOfficeSession('host-a', 'document-a')).toBe(sessionA)
    expect(await restarted.bindOfficeSession('host-a', 'document-b')).toBe(sessionB)
  }, 10_000)

  it('recovers a binding-map lock left by a crashed runtime', async () => {
    const directory = await stateDirectory()
    const deadPid = Number(execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid))'],
      { encoding: 'utf8' },
    ))
    await installBindingLock(directory, { token: 'crashed-runtime', pid: deadPid })
    const store = new OfficeSessionBindingStore(
      directory,
      () => 'office-session-recovered',
      { lockTimeoutMs: 80, lockRetryMs: 5 },
    )

    await expect(store.bindOfficeSession('host-a', 'document-a'))
      .resolves.toBe('office-session-recovered')
  }, 10_000)

  it('retries when the owner releases its lock during contender cleanup', async () => {
    const directory = await stateDirectory()
    const script = `
      import fs from 'node:fs/promises'
      import { syncBuiltinESMExports } from 'node:module'
      import { join } from 'node:path'
      import { OfficeSessionBindingStore } from ${JSON.stringify(bindingModuleUrl)}
      const directory = process.env.NEXUSDESK_TEST_STATE_DIRECTORY
      const owner = new OfficeSessionBindingStore(directory)
      const releaseOwner = await owner.tryAcquireBindingLock(
        join(directory, '.office-session-bindings.lock'),
      )
      if (!releaseOwner) throw new Error('Could not install the initial owner')
      const originalRm = fs.rm
      let released = false
      fs.rm = async (path, options) => {
        await originalRm(path, options)
        // Schedule a normal owner release after the contender's real collision.
        if (!released && path.startsWith(join(directory, '.office-session-bindings.candidate-'))) {
          released = true
          await releaseOwner()
        }
      }
      syncBuiltinESMExports()
      try {
        const contender = new OfficeSessionBindingStore(
          directory, () => 'office-session-after-release',
          { lockTimeoutMs: 500, lockRetryMs: 1 },
        )
        process.stdout.write(await contender.bindOfficeSession('host-a', 'document-a'))
      } finally {
        fs.rm = originalRm
        syncBuiltinESMExports()
        if (!released) await releaseOwner()
      }
    `

    await expect(execFileAsync(
      process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, NEXUSDESK_TEST_STATE_DIRECTORY: directory },
      },
    )).resolves.toMatchObject({ stdout: 'office-session-after-release' })
    expect(JSON.parse(await readFile(join(directory, 'office-session-bindings.json'), 'utf8')))
      .toEqual({
        version: 1,
        bindings: [{ hostId: 'host-a', documentId: 'document-a', sessionId: 'office-session-after-release' }],
      })
  }, 30_000)

  it('times out without deleting a lock owned by a live runtime', async () => {
    const directory = await stateDirectory()
    await installBindingLock(directory, { token: 'active-runtime', pid: process.pid })
    const store = new OfficeSessionBindingStore(
      directory,
      () => 'must-not-be-created',
      { lockTimeoutMs: 80, lockRetryMs: 5 },
    )
    const startedAt = Date.now()

    await expect(store.bindOfficeSession('host-a', 'document-a'))
      .rejects.toThrow(/timed out waiting for the Office Session binding map lock/i)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(JSON.parse(await readFile(
      join(directory, '.office-session-bindings.lock', 'owner.json'),
      'utf8',
    ))).toMatchObject({ token: 'active-runtime', pid: process.pid })
  }, 10_000)

  it('fails closed when the durable binding map is corrupt', async () => {
    const directory = await stateDirectory()
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(join(directory, 'office-session-bindings.json'), '{"version":1,"bindings":"broken"}'),
    )
    const store = new OfficeSessionBindingStore(directory, () => 'must-not-be-created')

    await expect(store.bindOfficeSession('host-a', 'document-a')).rejects.toThrow(/binding map/i)
  })
})

describe('Office turn context', () => {
  it('validates and deeply freezes the submitted editor selection', () => {
    const selection = {
      kind: 'sheets', sheetId: 'forecast-sheet', a1: 'C1:C3', columns: ['Revenue'],
    } as const
    const context = freezeOfficeTurnContext({
      hostId: 'host-a',
      documentId: 'document-a',
      editorType: 'sheets',
      revision: 7 as Revision,
      selection,
    })

    ;(selection as { a1: string }).a1 = 'Z99'

    expect(context.selection).toEqual({
      kind: 'sheets', sheetId: 'forecast-sheet', a1: 'C1:C3', columns: ['Revenue'],
    })
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.selection)).toBe(true)
    expect(Object.isFrozen((context.selection as unknown as { columns: string[] }).columns)).toBe(true)
  })

  it.each([
    {
      label: 'cross-editor selection',
      context: {
        hostId: 'host-a', documentId: 'document-a', editorType: 'docs', revision: 1,
        selection: { kind: 'slides', slide: 0, elements: [] },
      },
    },
    {
      label: 'unbounded sheet range',
      context: {
        hostId: 'host-a', documentId: 'document-a', editorType: 'sheets', revision: 1,
        selection: { kind: 'sheets', sheetId: 'sheet-1', a1: 'A:A' },
      },
    },
    {
      label: 'oversized sheet range',
      context: {
        hostId: 'host-a', documentId: 'document-a', editorType: 'sheets', revision: 1,
        selection: { kind: 'sheets', sheetId: 'sheet-1', a1: 'A1:XFD1048576' },
      },
    },
    {
      label: 'reversed document scope',
      context: {
        hostId: 'host-a', documentId: 'document-a', editorType: 'docs', revision: 1,
        selection: { kind: 'docs', startIndex: 3, endIndex: 1, isRange: false },
      },
    },
    {
      label: 'too many slide elements',
      context: {
        hostId: 'host-a', documentId: 'document-a', editorType: 'slides', revision: 1,
        selection: { kind: 'slides', slide: 0, elements: Array.from({ length: 257 }, (_, index) => `el-${index}`) },
      },
    },
  ])('rejects $label', ({ context }) => {
    expect(() => freezeOfficeTurnContext(context)).toThrow(/selection|context|range/i)
  })

  it('renders bounded context text for the official native prompt request', () => {
    const context = freezeOfficeTurnContext({
      hostId: 'host-a', documentId: 'document-a', editorType: 'slides', revision: 3 as Revision,
      selection: { kind: 'slides', slide: 2, elements: ['title-1'] },
    })

    const text = officeTurnContextText(context)

    expect(text).toContain('"elements":["title-1"]')
    expect(text).toContain('Host-validated and frozen at submission')
    expect(text).not.toContain('host-a')
  })
})

describe('acquireOfficeAgent', () => {
  const setup = vi.fn()
  const agentOptions = { provider: 'test', model: 'test' }

  it('creates only when the official persistence stat reports no Session', async () => {
    const handle = { agent: { inbox: { hasPending: false, clear: vi.fn() } }, dispose: vi.fn() }
    const create = vi.fn().mockResolvedValue(handle)
    const resume = vi.fn()

    const result = await acquireOfficeAgent({
      sessionId: 'office-session-1', cwd: '/workspace', setup, agentOptions,
      sessionPersistence: { stat: vi.fn().mockResolvedValue(undefined) },
      agents: { create, resume },
    })

    expect(result).toEqual({ handle, resumed: false })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'office-session-1', meta: { cwd: '/workspace' }, setup, agentOptions }))
    expect(resume).not.toHaveBeenCalled()
  })

  it('resumes an existing official Session and clears recovered queued work before returning', async () => {
    const clear = vi.fn()
    const handle = { agent: { inbox: { hasPending: true, clear } }, dispose: vi.fn() }
    const create = vi.fn()
    const resume = vi.fn().mockResolvedValue(handle)

    const result = await acquireOfficeAgent({
      sessionId: 'office-session-1', cwd: '/workspace', setup, agentOptions,
      sessionPersistence: { stat: vi.fn().mockResolvedValue({ header: { id: 'office-session-1' } }) },
      agents: { create, resume },
    })

    expect(result).toEqual({ handle, resumed: true })
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'office-session-1', setup, agentOptions }))
    expect(clear).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it('does not create on persistence corruption or resume ownership failure', async () => {
    const createAfterStatFailure = vi.fn()
    await expect(acquireOfficeAgent({
      sessionId: 'office-session-1', cwd: '/workspace', setup, agentOptions,
      sessionPersistence: { stat: vi.fn().mockRejectedValue(new Error('corrupt session')) },
      agents: { create: createAfterStatFailure, resume: vi.fn() },
    })).rejects.toThrow('corrupt session')
    expect(createAfterStatFailure).not.toHaveBeenCalled()

    const createAfterResumeFailure = vi.fn()
    await expect(acquireOfficeAgent({
      sessionId: 'office-session-1', cwd: '/workspace', setup, agentOptions,
      sessionPersistence: { stat: vi.fn().mockResolvedValue({ header: { id: 'office-session-1' } }) },
      agents: { create: createAfterResumeFailure, resume: vi.fn().mockRejectedValue(new Error('already owned')) },
    })).rejects.toThrow('already owned')
    expect(createAfterResumeFailure).not.toHaveBeenCalled()
  })

  it('disposes a resumed handle when recovered inbox cleanup fails', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined)
    const handle = {
      agent: { inbox: { hasPending: true, clear: vi.fn(() => { throw new Error('invalid inbox') }) } },
      dispose,
    }

    await expect(acquireOfficeAgent({
      sessionId: 'office-session-1', cwd: '/workspace', setup, agentOptions,
      sessionPersistence: { stat: vi.fn().mockResolvedValue({ header: { id: 'office-session-1' } }) },
      agents: { create: vi.fn(), resume: vi.fn().mockResolvedValue(handle) },
    })).rejects.toThrow('invalid inbox')
    expect(dispose).toHaveBeenCalledOnce()
  })
})
