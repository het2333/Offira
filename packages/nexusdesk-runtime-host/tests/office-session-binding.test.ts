import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Revision } from '@nexusdesk/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OfficeSessionBindingStore,
  acquireOfficeAgent,
  freezeOfficeTurnContext,
  officeTurnContextText,
} from '../src/office-session-binding'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexusdesk-office-session-test-'))
  directories.push(directory)
  return directory
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
