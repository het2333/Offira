import { expect, it, vi } from 'vitest'
import { createBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'

function setup(storageOverride?: any) {
  let receive: (frame: any) => void = () => {}
  const sent: any[] = []
  const values = new Map<string, string>()
  const client = {
    state: 'ready',
    clientId: 'client-1',
    connect() {},
    close() {},
    send(frame: any) {
      sent.push(frame)
    },
    request() {
      throw Error('unused')
    },
    onFrame(fn: typeof receive) {
      receive = fn
      return () => {}
    },
    onState() {
      return () => {}
    },
  }
  const bridge = createBrowserAgentBridge({
    client: client as never,
    documentId: 'sheets-1' as never,
    revision: 1 as never,
    storage: storageOverride ?? {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
    },
  })
  const frame = (command: string, args: any = {}, approval?: any) => ({
    type: 'editor:request',
    protocolVersion: 1,
    id: crypto.randomUUID(),
    target: {
      documentId: 'sheets-1',
      editorType: 'sheets',
      sessionId: 'session-1',
      operationId: 'operation-1',
      clientId: 'client-1',
      revision: 1,
    },
    command,
    arguments: args,
    ...(approval ? { approval } : {}),
  })
  return {
    bridge,
    values,
    sent,
    emit: (value: any) => receive(value),
    frame,
    results: () => sent.filter((value) => value.type === 'editor:result'),
  }
}

it('shares concurrent terminal requests and preserves success after a conflicting retry', async () => {
  const s = setup()
  let finish!: (value: any) => void
  let executions = 0
  const result = new Promise((resolve) => {
    finish = resolve
  })
  s.bridge.attachEditor({
    read: () => {
      executions++
      return result
    },
  } as never)
  const command = 'read_sheet'
  s.emit(s.frame(command, { a: 1, b: 2 }))
  s.emit(s.frame(command, { b: 2, a: 1 }))
  s.emit(s.frame(command, { a: 9 }))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  expect(s.results()[0].result.warnings[0].code).toBe('OPERATION_ID_COLLISION')
  expect(executions).toBe(1)
  finish({ ok: true, summary: 'executed once', warnings: [] })
  await vi.waitFor(() => expect(s.results()).toHaveLength(3))
  s.emit(s.frame(command, { a: 1, b: 2 }))
  await vi.waitFor(() => expect(s.results()).toHaveLength(4))
  expect(
    s
      .results()
      .slice(1)
      .every((value) => value.result.ok),
  ).toBe(true)
  expect(executions).toBe(1)
  s.bridge.dispose()
})

it('evicts old save proposals after the fixed proposal-cache limit', async () => {
  const s = setup()
  const save = vi.fn()
  s.bridge.attachEditor({ saveSnapshot: () => 'content', save } as never)
  s.emit(s.frame('propose_save'))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  const original = s.results()[0].result.data
  for (let index = 0; index < 128; index++) {
    const proposal = s.frame('propose_save')
    proposal.target.operationId = 'proposal-' + index
    s.emit(proposal)
  }
  await vi.waitFor(() => expect(s.results()).toHaveLength(129))
  s.emit(
    s.frame(
      'save_sheet',
      { inPlace: true, snapshotHash: original.snapshotHash },
      { id: 'approval-1', planHash: original.planHash },
    ),
  )
  await vi.waitFor(() => expect(s.results()).toHaveLength(130))
  expect(s.results()[129].result.ok).toBe(false)
  expect(save).not.toHaveBeenCalled()
  s.bridge.dispose()
})

it('journals thrown failures so retries do not rerun terminal commands', async () => {
  const s = setup()
  let executions = 0
  s.bridge.attachEditor({
    read: () => {
      executions++
      throw Error('read failed')
    },
  } as never)
  const frame = s.frame('read_sheet')
  s.emit(frame)
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  s.emit(frame)
  await vi.waitFor(() => expect(s.results()).toHaveLength(2))
  expect(executions).toBe(1)
  expect(s.results()[1].result.warnings[0].code).toBe('EDITOR_REQUEST_FAILED')
  s.bridge.dispose()
})

it('binds save approval to the full snapshot and rejects changes after proposal', async () => {
  const s = setup()
  let snapshot = 'full-content-v1'
  let saves = 0
  s.bridge.attachEditor({
    saveSnapshot: () => snapshot,
    save: async () => {
      saves++
      return { ok: true, summary: 'saved', warnings: [] }
    },
  } as never)
  s.emit(s.frame('propose_save'))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  const proposed = s.results()[0].result
  expect(proposed.ok).toBe(true)
  expect(proposed.data).toMatchObject({
    operationId: 'operation-1',
    snapshotHash: expect.any(String),
    planHash: expect.any(String),
    targets: expect.any(Array),
  })
  snapshot = 'full-content-v2'
  s.emit(
    s.frame(
      'save_sheet',
      { inPlace: true, snapshotHash: proposed.data.snapshotHash },
      { id: 'approval-1', planHash: proposed.data.planHash },
    ),
  )
  await vi.waitFor(() => expect(s.results()).toHaveLength(2))
  expect(s.results()[1].result.warnings[0].code).toBe('STALE_CONTENT')
  expect(saves).toBe(0)
  s.bridge.dispose()
})

it('saves the approved snapshot once when approval delivery is duplicated', async () => {
  const s = setup()
  let saves = 0
  let finish!: (value: any) => void
  s.bridge.attachEditor({
    saveSnapshot: () => 'full-content',
    save: () => {
      saves++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  } as never)
  s.emit(s.frame('propose_save'))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  const proposed = s.results()[0].result
  expect(proposed.ok).toBe(true)
  const save = s.frame(
    'save_sheet',
    { inPlace: true, snapshotHash: proposed.data.snapshotHash },
    { id: 'approval-1', planHash: proposed.data.planHash },
  )
  s.emit(save)
  s.emit(save)
  await vi.waitFor(() => expect(saves).toBe(1))
  finish({ ok: true, summary: 'saved once', warnings: [] })
  await vi.waitFor(() => expect(s.results()).toHaveLength(3))
  expect(
    s
      .results()
      .slice(1)
      .every((value) => value.result.ok),
  ).toBe(true)
  s.bridge.dispose()
})

it.each(['getItem', 'setItem', 'removeItem'])(
  'continues terminal requests when storage.%s throws',
  async (method) => {
    const s = setup({
      getItem: () => {
        if (method === 'getItem') throw Error('denied')
        return method === 'removeItem' ? '{invalid' : null
      },
      setItem: () => {
        if (method === 'setItem') throw Error('quota')
      },
      removeItem: () => {
        throw Error('denied')
      },
    })
    let reads = 0
    s.bridge.attachEditor({
      read: async () => {
        reads++
        return { ok: true, summary: 'read', warnings: [] }
      },
    } as never)
    expect(() => s.emit(s.frame('read_sheet'))).not.toThrow()
    await vi.waitFor(() => expect(s.results()).toHaveLength(1))
    expect(s.results()[0].result.ok).toBe(true)
    expect(reads).toBe(1)
    s.bridge.dispose()
  },
)

it('evicts completed promises and journals beyond the per-document limit', async () => {
  const s = setup()
  let reads = 0
  s.bridge.attachEditor({
    read: async () => {
      reads++
      return { ok: true, summary: 'read', warnings: [] }
    },
  } as never)
  for (let index = 0; index < 130; index++) {
    const frame = s.frame('read_sheet')
    frame.target.operationId = 'read-' + index
    s.emit(frame)
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  }
  await vi.waitFor(() => expect(s.results()).toHaveLength(130))
  expect(s.values.size).toBeLessThanOrEqual(129)
  const first = s.frame('read_sheet')
  first.target.operationId = 'read-0'
  s.emit(first)
  await vi.waitFor(() => expect(s.results()).toHaveLength(131))
  expect(reads).toBe(131)
  s.bridge.dispose()
})

it('does not retain oversized result records in session storage', async () => {
  const s = setup()
  s.bridge.attachEditor({
    read: async () => ({
      ok: true,
      summary: 'large',
      warnings: [],
      data: { text: 'x'.repeat(300 * 1024) },
    }),
  } as never)
  s.emit(s.frame('read_sheet'))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  expect([...s.values.values()].every((value) => value.length <= 64 * 1024)).toBe(true)
  s.bridge.dispose()
})
