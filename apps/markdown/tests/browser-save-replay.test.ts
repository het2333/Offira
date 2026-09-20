import { expect, it, vi } from 'vitest'
import { createMarkdownBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'

function setup() {
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
  const bridge = createMarkdownBrowserAgentBridge({
    client: client as never,
    documentId: 'markdown-1' as never,
    revision: 1 as never,
    storage: {
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
      documentId: 'markdown-1',
      editorType: 'markdown',
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
  const command = 'read_markdown'
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

it('journals thrown failures so retries do not rerun terminal commands', async () => {
  const s = setup()
  let executions = 0
  s.bridge.attachEditor({
    read: () => {
      executions++
      throw Error('read failed')
    },
  } as never)
  const frame = s.frame('read_markdown')
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
      'save_markdown',
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
    'save_markdown',
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
