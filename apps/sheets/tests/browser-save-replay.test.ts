import { expect, it, vi } from 'vitest'
import { BoundedEditorCache, createWorkingCopyMutationLane } from '@nexusdesk/web-client'
import { createBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'

function setup(storageOverride?: any, workingCopy?: any) {
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
    ...(workingCopy ? { workingCopy } : {}),
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

it('durable apply delivers success only after full capture commits and carries the receipt', async () => {
  let finish!: (value: any) => void
  let mutations = 0
  let captures = 0
  let committed = false
  const receipt = {
    documentEpoch: 'epoch',
    operationId: 'operation-1',
    requestFingerprint: 'fingerprint',
    checkpointId: 'checkpoint',
    blobHash: 'a'.repeat(64),
    workingRevision: 2,
    savedRevision: 1,
    dirty: true,
  }
  const workingCopy = {
    state: () => ({ documentEpoch: 'epoch' }),
    lane: createWorkingCopyMutationLane(),
    capture: async () => {
      captures++
      return { kind: 'xlsx-save-plan', parts: new Map() }
    },
    persistence: {
      lookup: async () => ({ state: 'not-found' }),
      checkpoint: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    },
    committed: () => {
      committed = true
    },
  }
  const s = setup(undefined, workingCopy)
  s.bridge.attachEditor({
    propose: async () => ({ planHash: 'plan', summary: 'edit', warnings: [], operations: [] }),
    apply: async () => {
      mutations++
      return { ok: true, summary: 'applied', warnings: [] }
    },
  } as never)
  s.emit(s.frame('propose_ops'))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  s.emit(s.frame('apply_ops', {}, { id: 'approval', planHash: 'plan' }))
  await vi.waitFor(() => expect(captures).toBe(1))
  expect(s.results()).toHaveLength(1)
  finish(receipt)
  await vi.waitFor(() => expect(s.results()).toHaveLength(2))
  expect(s.results()[1]).toMatchObject({ result: { ok: true }, persistence: receipt })
  expect(mutations).toBe(1)
  expect(committed).toBe(true)
  s.bridge.dispose()
})

it('durable historical lookup supersedes absent proposals without executing the mutation again', async () => {
  let mutations = 0
  const receipt = {
    documentEpoch: 'epoch',
    operationId: 'operation-1',
    requestFingerprint: 'f',
    checkpointId: 'cp',
    blobHash: 'a'.repeat(64),
    workingRevision: 2,
    savedRevision: 1,
    dirty: true,
  }
  const s = setup(undefined, {
    state: () => ({ documentEpoch: 'epoch' }),
    lane: createWorkingCopyMutationLane(),
    persistence: {
      lookup: async () => ({
        state: 'committed',
        persistence: receipt,
        result: { ok: true, summary: 'original', warnings: [] },
      }),
    },
    committed: () => {},
  })
  s.bridge.attachEditor({
    apply: async () => {
      mutations++
      throw Error('must not run')
    },
  } as never)
  s.emit(s.frame('apply_ops', {}, { id: 'approval', planHash: 'plan' }))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  expect(s.results()[0]).toMatchObject({
    result: { ok: true, summary: 'original' },
    persistence: receipt,
  })
  expect(mutations).toBe(0)
  s.bridge.dispose()
})

it('keeps the Save lock until asynchronous reopen and hydration finish', async () => {
  let locked = false
  let finish!: () => void
  const s = setup(undefined, {
    state: () => ({ documentEpoch: 'epoch' }),
    lane: createWorkingCopyMutationLane(),
    lock: () => {
      locked = true
      return () => {
        locked = false
      }
    },
    capture: async () => ({ kind: 'xlsx-save-plan', parts: new Map() }),
    persistence: {
      lookup: async () => ({ state: 'not-found' }),
      checkpoint: async () => ({ workingRevision: 2 }),
    },
    committed: () => {},
    afterSave: () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  })
  s.bridge.attachEditor({ saveSnapshot: () => 'approved' } as never)
  s.emit(s.frame('propose_save'))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  const proposal = s.results()[0].result.data
  s.emit(
    s.frame(
      'save_sheet',
      { snapshotHash: proposal.snapshotHash },
      { id: 'approval', planHash: proposal.planHash },
    ),
  )
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(locked).toBe(true)
  expect(s.results()).toHaveLength(1)
  finish()
  await vi.waitFor(() => expect(s.results()).toHaveLength(2))
  expect(locked).toBe(false)
  s.bridge.dispose()
})

it('rejects an approved Save if content changes between validation and acquiring the capture lock', async () => {
  let content = 'approved'
  let writes = 0
  const s = setup(undefined, {
    state: () => ({ documentEpoch: 'epoch' }),
    lane: createWorkingCopyMutationLane(),
    lock: () => {
      content = 'late manual change'
      return () => {}
    },
    capture: async () => ({ kind: 'xlsx-save-plan', parts: new Map() }),
    persistence: {
      lookup: async () => ({ state: 'not-found' }),
      checkpoint: async () => {
        writes++
        throw Error('must not write')
      },
    },
    committed: () => {},
  })
  s.bridge.attachEditor({ saveSnapshot: () => content } as never)
  s.emit(s.frame('propose_save'))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  const proposal = s.results()[0].result.data
  s.emit(
    s.frame(
      'save_sheet',
      { snapshotHash: proposal.snapshotHash },
      { id: 'approval', planHash: proposal.planHash },
    ),
  )
  await vi.waitFor(() => expect(s.results()).toHaveLength(2))
  expect(s.results()[1].result.ok).toBe(false)
  expect(writes).toBe(0)
  s.bridge.dispose()
})

it('rejects a plan after manual content changes even when the durable revision is unchanged', async () => {
  const s = setup()
  let content = 'before'
  let mutations = 0
  s.bridge.attachEditor({
    saveSnapshot: () => content,
    propose: async () => ({ planHash: 'plan', summary: 'edit', warnings: [], operations: [] }),
    apply: async () => {
      mutations++
      return { ok: true, summary: 'applied', warnings: [] }
    },
  } as never)
  s.emit(s.frame('propose_ops'))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  content = 'manual change'
  s.emit(s.frame('apply_ops', {}, { id: 'approval', planHash: 'plan' }))
  await vi.waitFor(() => expect(s.results()).toHaveLength(2))
  expect(s.results()[1].result).toMatchObject({ ok: false, warnings: [{ code: 'STALE_CONTENT' }] })
  expect(mutations).toBe(0)
  s.bridge.dispose()
})

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

it.each([70, 255])(
  'replays the same successful terminal result for a legal %s KiB mutation',
  async (kib) => {
    const s = setup()
    const result = { ok: true, summary: 'applied the large edit once', warnings: [] }
    const apply = vi.fn(async () => result)
    const operations = [
      {
        op: 'set_range',
        sheetId: 'sheet-1',
        start: 'A1',
        values: Array.from({ length: 10 }, () => ['x'.repeat((kib * 1024) / 10)]),
      },
    ]
    s.bridge.attachEditor({
      propose: async (request: any) => ({
        ...request,
        operations,
        planHash: 'large-plan',
        summary: 'large edit',
        warnings: [],
      }),
      apply,
    } as never)
    s.emit(s.frame('propose_ops', { ops: operations }))
    await vi.waitFor(() => expect(s.results()).toHaveLength(1))
    expect(new TextEncoder().encode(JSON.stringify({ ops: operations })).byteLength).toBeLessThan(
      256 * 1024,
    )
    const request = s.frame(
      'apply_ops',
      { ops: operations },
      { id: 'approval-1', planHash: 'large-plan' },
    )
    s.emit(request)
    await vi.waitFor(() => expect(s.results()).toHaveLength(2))
    expect(s.results()[1].result).toEqual(result)
    s.emit(request)
    await vi.waitFor(() => expect(s.results()).toHaveLength(3))
    expect(s.results()[2].result).toEqual(result)
    expect(apply).toHaveBeenCalledTimes(1)
    expect([...s.values.values()].every((value) => value.length <= 64 * 1024)).toBe(true)
    const receipt = [...s.values.values()]
      .map((value) => JSON.parse(value))
      .find((value) => value.result)
    expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    s.bridge.dispose()
    const reloaded = setup({
      getItem: (key: string) => s.values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        s.values.set(key, value)
      },
      removeItem: (key: string) => {
        s.values.delete(key)
      },
    })
    reloaded.bridge.attachEditor({ apply } as never)
    reloaded.emit(request)
    await vi.waitFor(() => expect(reloaded.results()).toHaveLength(1))
    expect(reloaded.results()[0].result).toEqual(result)
    expect(apply).toHaveBeenCalledTimes(1)
    reloaded.bridge.dispose()
  },
)

it.each(['rejected', 'cancelled'])('immediately releases a proposal after %s', async (outcome) => {
  const s = setup()
  const apply = vi.fn(async () => ({ ok: true, summary: 'must not execute', warnings: [] }))
  const operations = [{ op: 'insert_text', text: 'private proposal text' }]
  s.bridge.attachEditor({
    propose: async (request: any) => ({
      ...request,
      operations,
      planHash: 'released-plan',
      summary: 'edit',
      warnings: [],
    }),
    apply,
  } as never)
  s.emit(s.frame('propose_ops', { ops: operations }))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  s.emit({
    type: 'agent:event',
    protocolVersion: 1,
    sessionId: 'session-1',
    event: { type: 'editor:proposal-released', data: { operationId: 'operation-1', outcome } },
  })
  s.emit(
    s.frame('apply_ops', { ops: operations }, { id: 'late-approval', planHash: 'released-plan' }),
  )
  await vi.waitFor(() => expect(s.results()).toHaveLength(2))
  expect(s.results()[1].result.ok).toBe(false)
  expect(apply).not.toHaveBeenCalled()
  s.bridge.dispose()
})

it.each(['rejected', 'cancelled'])(
  'deletes the retained save snapshot immediately after %s',
  async (outcome) => {
    const s = setup()
    const cacheSet = vi.spyOn(BoundedEditorCache.prototype, 'set')
    try {
      s.bridge.attachEditor({
        saveSnapshot: () => 'private full snapshot'.repeat(4096),
        proposeSave: async () => ({
          planHash: 'released-save-plan',
          contentVersion: 1,
          summary: 'save',
          targets: [],
          warnings: [],
        }),
      } as never)
      s.emit(s.frame('propose_save'))
      await vi.waitFor(() => expect(s.results()).toHaveLength(1))
      expect(s.results()[0].result.ok).toBe(true)
      const index = cacheSet.mock.calls.findIndex(
        ([key, value]) =>
          key === 'operation-1' &&
          value &&
          typeof value === 'object' &&
          ('snapshot' in value || 'contentVersion' in value),
      )
      expect(index).toBeGreaterThanOrEqual(0)
      const cache = cacheSet.mock.contexts[index] as Map<string, unknown>
      expect(cache.has('operation-1')).toBe(true)
      s.emit({
        type: 'agent:event',
        protocolVersion: 1,
        sessionId: 'session-1',
        event: { type: 'editor:proposal-released', data: { operationId: 'operation-1', outcome } },
      })
      expect(cache.has('operation-1')).toBe(false)
    } finally {
      s.bridge.dispose()
      cacheSet.mockRestore()
    }
  },
)

it('preserves a mutation that completes after bridge disposal for persistent replay', async () => {
  const s = setup()
  let finish!: (value: any) => void
  const result = { ok: true, summary: 'completed after disposal', warnings: [] }
  const apply = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const operations = [{ op: 'edit' }]
  s.bridge.attachEditor({
    propose: async (request: any) => ({
      ...request,
      operations,
      planHash: 'late-plan',
      summary: 'edit',
      warnings: [],
    }),
    apply,
  } as never)
  s.emit(s.frame('propose_ops', { ops: operations }))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  const request = s.frame(
    'apply_ops',
    { ops: operations },
    { id: 'approval', planHash: 'late-plan' },
  )
  s.emit(request)
  await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
  s.bridge.dispose()
  finish(result)
  await vi.waitFor(() => expect(s.results()).toHaveLength(2))
  expect(s.results()[1].result).toEqual(result)
  const reloaded = setup({
    getItem: (key: string) => s.values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      s.values.set(key, value)
    },
    removeItem: (key: string) => {
      s.values.delete(key)
    },
  })
  reloaded.bridge.attachEditor({ apply } as never)
  reloaded.emit(request)
  await vi.waitFor(() => expect(reloaded.results()).toHaveLength(1))
  expect(reloaded.results()[0].result).toEqual(result)
  expect(apply).toHaveBeenCalledTimes(1)
  reloaded.bridge.dispose()
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
    await vi.waitFor(() => expect(s.results()).toHaveLength(index + 1), { interval: 1 })
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
