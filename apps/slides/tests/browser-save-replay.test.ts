import { expect, it, vi } from 'vitest'
import { BoundedEditorCache } from '@nexusdesk/web-client'
import { createSlidesBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'

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
  const bridge = createSlidesBrowserAgentBridge({
    client: client as never,
    documentId: 'slides-1' as never,
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
      documentId: 'slides-1',
      editorType: 'slides',
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
  const command = 'read_presentation'
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
  s.bridge.attachEditor({
    proposeSave: async () => ({
      planHash: 'approved-hash',
      summary: 'save',
      warnings: [],
      targets: [],
      contentVersion: 1,
    }),
    save,
  } as never)
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
      'save_presentation',
      { inPlace: true, contentVersion: original.contentVersion },
      { id: 'approval-1', planHash: original.planHash },
    ),
  )
  await vi.waitFor(() => expect(s.results()).toHaveLength(130))
  expect(s.results()[129].result.ok).toBe(false)
  expect(s.results()[129].result.warnings[0].code).toBe('APPROVAL_INVALID')
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
        op: 'setText',
        target: { slide: 0, el: 'title' },
        paragraphs: [{ runs: [{ text: 'x'.repeat(kib * 1024) }] }],
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
  const frame = s.frame('read_presentation')
  s.emit(frame)
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  s.emit(frame)
  await vi.waitFor(() => expect(s.results()).toHaveLength(2))
  expect(executions).toBe(1)
  expect(s.results()[1].result.warnings[0].code).toBe('EDITOR_REQUEST_FAILED')
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
    expect(() => s.emit(s.frame('read_presentation'))).not.toThrow()
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
    const frame = s.frame('read_presentation')
    frame.target.operationId = 'read-' + index
    s.emit(frame)
    await vi.waitFor(() => expect(s.results()).toHaveLength(index + 1), { interval: 1 })
  }
  await vi.waitFor(() => expect(s.results()).toHaveLength(130))
  expect(s.values.size).toBeLessThanOrEqual(129)
  const first = s.frame('read_presentation')
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
  s.emit(s.frame('read_presentation'))
  await vi.waitFor(() => expect(s.results()).toHaveLength(1))
  expect([...s.values.values()].every((value) => value.length <= 64 * 1024)).toBe(true)
  s.bridge.dispose()
})
