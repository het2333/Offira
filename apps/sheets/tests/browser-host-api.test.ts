import { describe, expect, it, vi } from 'vitest'

import {
  PROTOCOL_VERSION,
  type AgentServerFrame,
  type ClientFrame,
  type ClientId,
  type DocumentId,
  type EditorAdapter,
  type OperationId,
  type RequestId,
  type Revision,
  type SessionId,
} from '@nexusdesk/protocol'
import { createBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'
import {
  createBrowserDesktopApi,
  installBrowserHostApi,
  loadBrowserHostBootstrap,
  selectSheetsHost,
  WebHostUnavailableError,
  type BrowserHostBootstrap,
} from '../src/renderer/browser-host-api'
import type { WorkbookFile } from '../src/shared/desktop-api'
import { createAgentLoopRuntime } from '../src/renderer/ai/loop-runtime'
import { createRendererServerOptions } from '../vite.renderer.config'

class FakeClient {
  state = 'ready' as const
  clientId = 'client-1' as ClientId
  readonly sent: ClientFrame[] = []
  connectCount = 0
  closeCount = 0
  private readonly listeners = new Set<(frame: AgentServerFrame) => void>()

  connect(): void {
    this.connectCount += 1
  }
  close(): void {
    this.closeCount += 1
  }
  send(frame: ClientFrame): void {
    this.sent.push(frame)
  }
  request(): Promise<AgentServerFrame> {
    throw new Error('not used')
  }
  onFrame(listener: (frame: AgentServerFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onState(): () => void {
    return () => undefined
  }
  emit(frame: AgentServerFrame): void {
    for (const listener of this.listeners) listener(frame)
  }
}

class FailingResultClient extends FakeClient {
  override send(frame: ClientFrame): void {
    if (frame.type === 'editor:result') throw new Error('CONNECTION_LOST')
    super.send(frame)
  }
}

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const documentId = 'document-1' as DocumentId
const revision = 1 as Revision

function browserBootstrap(): BrowserHostBootstrap {
  return {
    documentId,
    title: 'Forecast.xlsx',
    revision,
    websocketUrl: 'ws://127.0.0.1:43123/ws',
    language: 'zh',
    theme: 'system',
    workbook: {
      sessionId: 'b7e8d760-429a-4871-8888-d695ff93cd7a',
      name: 'Forecast.xlsx',
      sha256: 'a'.repeat(64),
      entryCount: 1,
      sheets: [],
      activeTab: 0,
      styles: [],
      dxfStyles: [],
      visuals: [],
      definedNames: [],
      readOnly: false,
    } as unknown as WorkbookFile,
  }
}

function adapterWith(overrides: Partial<EditorAdapter> = {}): EditorAdapter {
  return {
    editorType: 'sheets',
    capabilities: () => ({
      editorType: 'sheets',
      commands: ['read_sheet', 'apply_ops', 'save_sheet'],
      canUndo: true,
      canSave: true,
      canExport: true,
    }),
    snapshot: vi.fn(),
    read: vi.fn().mockResolvedValue({ ok: true, summary: 'read', warnings: [], data: {} }),
    propose: vi.fn().mockResolvedValue({
      target: {
        sessionId: 'session-1' as SessionId,
        documentId,
        editorType: 'sheets',
        revision,
        operationId: 'operation-1' as OperationId,
        clientId: 'client-1' as ClientId,
      },
      planId: 'plan-1',
      planHash: 'exact-plan-hash',
      summary: 'Apply one operation.',
      operations: [],
      warnings: [],
    }),
    apply: vi.fn().mockImplementation(async (plan) => ({
      ok: plan.approvalId === 'approval-1',
      summary: 'applied',
      warnings: [],
    })),
    verify: vi.fn(),
    undo: vi.fn(),
    save: vi.fn().mockResolvedValue({ ok: true, summary: 'saved', warnings: [] }),
    export: vi.fn(),
    ...overrides,
  }
}

describe('Sheets host selection', () => {
  it('uses the local Web host when explicitly requested even if Electron preload exists', async () => {
    const browserHost = { dispose: vi.fn() }
    const installBrowser = vi.fn().mockResolvedValue(browserHost)
    const electronApi = { getLanguage: vi.fn() }

    const selected = await selectSheetsHost({
      search: '?host=local-web',
      electronApi,
      installBrowser,
    })

    expect(selected).toEqual({ kind: 'local-web', handle: browserHost })
    expect(installBrowser).toHaveBeenCalledTimes(1)
  })

  it('uses the Electron preload when browser mode is not requested', async () => {
    const installBrowser = vi.fn()
    const electronApi = { getLanguage: vi.fn() }

    const selected = await selectSheetsHost({ search: '', electronApi, installBrowser })

    expect(selected).toEqual({ kind: 'electron' })
    expect(installBrowser).not.toHaveBeenCalled()
  })

  it('returns a visible startup error when neither host implementation is available', async () => {
    const selected = await selectSheetsHost({
      search: '',
      electronApi: undefined,
      installBrowser: vi.fn(),
    })

    expect(selected).toEqual({
      kind: 'error',
      message:
        'NexusDesk Sheets could not start: Electron preload is unavailable and local Web mode was not requested.',
    })
  })
})

describe('browser agent bridge', () => {
  it('proposes first and applies only the exact Host-approved plan hash', async () => {
    const client = new FakeClient()
    const adapter = adapterWith()
    const bridge = createBrowserAgentBridge({ client, documentId, revision })
    bridge.attachEditor(adapter)

    expect(bridge.client()).toEqual({ clientId: 'client-1', attached: true })

    client.emit({
      type: 'editor:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'editor-request-1' as RequestId,
      target: {
        sessionId: 'session-1' as SessionId,
        documentId,
        editorType: 'sheets',
        revision,
        operationId: 'operation-1' as OperationId,
        clientId: 'client-1' as ClientId,
      },
      command: 'propose_ops',
      arguments: { ops: [] },
    })
    await vi.waitFor(() =>
      expect(client.sent.some((frame) => frame.type === 'editor:result')).toBe(true),
    )

    expect(adapter.apply).not.toHaveBeenCalled()
    expect(client.sent.find((frame) => frame.type === 'editor:result')).toMatchObject({
      result: {
        ok: true,
        data: {
          planHash: 'exact-plan-hash',
          summary: 'Apply one operation.',
        },
      },
    })

    client.emit({
      type: 'editor:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'editor-apply-1' as RequestId,
      target: {
        sessionId: 'session-1' as SessionId,
        documentId,
        editorType: 'sheets',
        revision,
        operationId: 'operation-1' as OperationId,
        clientId: 'client-1' as ClientId,
      },
      command: 'apply_ops',
      arguments: { ops: [] },
      approval: { id: 'approval-1' as RequestId, planHash: 'exact-plan-hash' },
    })
    await vi.waitFor(() =>
      expect(client.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(2),
    )

    expect(adapter.propose).toHaveBeenCalledTimes(1)
    expect(adapter.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        planHash: 'exact-plan-hash',
        approvalId: 'approval-1',
      }),
    )
    expect(client.sent.filter((frame) => frame.type === 'editor:result').at(-1)).toEqual({
      type: 'editor:result',
      protocolVersion: PROTOCOL_VERSION,
      id: 'editor-apply-1',
      target: expect.objectContaining({ documentId, operationId: 'operation-1' }),
      result: { ok: true, summary: 'applied', warnings: [] },
    })
    expect(bridge.consumeApproval('approval-1', 'exact-plan-hash')).toBe(false)
  })

  it('replays a committed result after reload without applying the operation twice', async () => {
    const storage = new MemoryStorage()
    const firstClient = new FakeClient()
    const firstAdapter = adapterWith()
    const first = createBrowserAgentBridge({ client: firstClient, documentId, revision, storage })
    first.attachEditor(firstAdapter)
    const target = {
      sessionId: 'session-1' as SessionId,
      documentId,
      editorType: 'sheets',
      revision,
      operationId: 'operation-recover' as OperationId,
      clientId: 'client-1' as ClientId,
    }
    firstClient.emit({
      type: 'editor:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'propose-1' as RequestId,
      target,
      command: 'propose_ops',
      arguments: { ops: [] },
    })
    await vi.waitFor(() =>
      expect(firstClient.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(1),
    )
    firstClient.emit({
      type: 'editor:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'apply-1' as RequestId,
      target,
      command: 'apply_ops',
      arguments: { ops: [] },
      approval: { id: 'approval-1' as RequestId, planHash: 'exact-plan-hash' },
    })
    await vi.waitFor(() =>
      expect(firstClient.sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(2),
    )
    first.dispose()

    const reloadedClient = new FakeClient()
    const reloadedAdapter = adapterWith({ apply: vi.fn() })
    const reloaded = createBrowserAgentBridge({
      client: reloadedClient,
      documentId,
      revision: 2 as Revision,
      storage,
    })
    reloaded.attachEditor(reloadedAdapter)
    reloadedClient.emit({
      type: 'editor:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'apply-retry' as RequestId,
      target: {
        ...target,
        sessionId: 'session-2' as SessionId,
        clientId: 'client-1' as ClientId,
        revision: 2 as Revision,
      },
      command: 'apply_ops',
      arguments: { ops: [] },
      approval: { id: 'approval-2' as RequestId, planHash: 'exact-plan-hash' },
    })

    await vi.waitFor(() =>
      expect(reloadedClient.sent.some((frame) => frame.type === 'editor:result')).toBe(true),
    )
    expect(reloadedAdapter.apply).not.toHaveBeenCalled()
    expect(reloadedClient.sent.find((frame) => frame.type === 'editor:result')).toMatchObject({
      result: { ok: true, summary: 'applied' },
    })
    reloaded.dispose()
  })

  it('returns a typed Agent failure for a command outside editor capabilities', async () => {
    const client = new FakeClient()
    const bridge = createBrowserAgentBridge({ client, documentId, revision })
    bridge.attachEditor(adapterWith())

    client.emit({
      type: 'editor:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'editor-request-2' as RequestId,
      target: {
        sessionId: 'session-1' as SessionId,
        documentId,
        editorType: 'sheets',
        revision,
        operationId: 'operation-2' as OperationId,
        clientId: 'client-1' as ClientId,
      },
      command: 'engine_object',
      arguments: {},
    })
    await vi.waitFor(() =>
      expect(client.sent.some((frame) => frame.type === 'editor:result')).toBe(true),
    )

    expect(client.sent.find((frame) => frame.type === 'editor:result')).toMatchObject({
      result: {
        ok: false,
        warnings: [{ code: 'UNAVAILABLE_IN_WEB' }],
      },
    })
  })

  it('keeps a successful journal result when delivery loses its connection', async () => {
    const storage = new MemoryStorage()
    const client = new FailingResultClient()
    const adapter = adapterWith()
    const bridge = createBrowserAgentBridge({ client, documentId, revision, storage })
    bridge.attachEditor(adapter)

    client.emit({
      type: 'editor:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'save-1' as RequestId,
      target: {
        sessionId: 'session-1' as SessionId,
        documentId,
        editorType: 'sheets',
        revision,
        operationId: 'operation-save' as OperationId,
        clientId: 'client-1' as ClientId,
      },
      command: 'read_sheet',
      arguments: {},
    })

    await vi.waitFor(() => expect(adapter.read).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      const saved = storage.getItem('nexusdesk:editor-result:document-1:operation-save')
      expect(saved).not.toBeNull()
      expect(JSON.parse(saved!).result).toMatchObject({ ok: true, summary: 'read' })
    })
    bridge.dispose()
  })
})

describe('browser Desktop API', () => {
  it('offers the authenticated workbook exactly once to the existing Sheets open flow', async () => {
    const api = createBrowserDesktopApi(browserBootstrap(), { request: vi.fn() })

    await expect(api.hasQueuedWorkbook()).resolves.toBe(true)
    await expect(api.selectWorkbook()).resolves.toMatchObject({ name: 'Forecast.xlsx' })
    await expect(api.hasQueuedWorkbook()).resolves.toBe(false)
    await expect(api.selectWorkbook()).resolves.toBeNull()
  })

  it('routes workbook saves through the named Local Host action', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, file: browserBootstrap().workbook })
    const api = createBrowserDesktopApi(browserBootstrap(), { request })
    const saveRequest = {
      sessionId: browserBootstrap().workbook.sessionId,
      mode: 'save',
      edits: [],
    }

    await api.saveWorkbookEdits(saveRequest as never)

    expect(request).toHaveBeenCalledWith('save-workbook', saveRequest)
  })

  it('rejects desktop-only commands with a typed unavailable error', async () => {
    const api = createBrowserDesktopApi(browserBootstrap(), { request: vi.fn() })

    await expect(api.pickAttachments()).rejects.toMatchObject({ code: 'UNAVAILABLE_IN_WEB' })
    await expect(api.pickAttachments()).rejects.toBeInstanceOf(WebHostUnavailableError)
  })
})

describe('browser host installation', () => {
  it('installs both stable browser APIs and owns their complete lifecycle', () => {
    const client = new FakeClient()
    const target: Record<string, unknown> = {}

    const handle = installBrowserHostApi(browserBootstrap(), {
      client,
      target,
      transport: { request: vi.fn() },
    })

    expect(target.desktopApi).toBeDefined()
    expect(target.agentApi).toBe(handle.bridge.agentApi)
    expect(target.nexusdeskBrowserHost).toBe(handle)
    expect(client.connectCount).toBe(1)

    handle.updateRevision(2 as Revision)
    expect(handle.document.revision).toBe(2)
    expect(client.sent.at(-1)).toMatchObject({ type: 'editor:revision', revision: 2 })

    handle.dispose()
    expect(target).toEqual({})
    expect(client.closeCount).toBe(1)
  })

  it('loads an authenticated editor bootstrap by stable document id', async () => {
    const bootstrap = browserBootstrap()
    const fetchBootstrap = vi.fn().mockResolvedValue(Response.json(bootstrap))

    await expect(loadBrowserHostBootstrap('document / 1', fetchBootstrap)).resolves.toEqual(
      bootstrap,
    )
    expect(fetchBootstrap).toHaveBeenCalledWith('/api/documents/document%20%2F%201/bootstrap', {
      credentials: 'same-origin',
    })
  })
})

describe('browser Agent loop runtime', () => {
  it('starts a Harness turn against the stable document id instead of a filesystem path', () => {
    const startTurn = vi.fn()
    const runtime = createAgentLoopRuntime(
      {
        transport: {} as never,
        skill: {} as never,
        getDocumentId: () => documentId,
      },
      {
        startTurn,
        cancelTurn: vi.fn(),
        respondApproval: vi.fn(),
        onFrame: vi.fn(() => () => undefined),
      },
    )

    runtime.run('Update the forecast')

    expect(startTurn).toHaveBeenCalledWith({
      prompt: 'Update the forecast',
      documentId,
      sessionId: expect.stringMatching(/^sheets-/),
    })
  })

  it('shows the exact structured proposal that is bound to approval', () => {
    let receive: ((frame: AgentServerFrame) => void) | undefined
    const respondApproval = vi.fn()
    const startTurn = vi.fn()
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    const runtime = createAgentLoopRuntime(
      {
        transport: {} as never,
        skill: {} as never,
        getDocumentId: () => documentId,
      },
      {
        startTurn,
        cancelTurn: vi.fn(),
        respondApproval,
        onFrame: vi.fn((callback) => {
          receive = callback
          return () => undefined
        }),
      },
    )
    runtime.run('Update the forecast')

    receive?.({
      type: 'approval:request',
      protocolVersion: PROTOCOL_VERSION,
      id: 'approval-1' as RequestId,
      sessionId: startTurn.mock.calls[0]![0].sessionId as SessionId,
      toolName: 'apply_sheet_operations',
      proposal: {
        planHash: 'exact-plan-hash',
        summary: 'Apply 2 operations to Summary!B2 and Summary!C2.',
        targets: ['Summary!B2', 'Summary!C2'],
        warnings: [{ code: 'NOTICE', message: 'Formula will recalculate.' }],
      },
    })

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Apply 2 operations'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Summary!B2'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Formula will recalculate.'))
    expect(confirm.mock.calls[0]?.[0]).not.toContain('[object Object]')
    expect(respondApproval).toHaveBeenCalledWith('approval-1', 'allowed-once')
    vi.unstubAllGlobals()
  })
})

describe('browser renderer development proxy', () => {
  it('fails startup when local Web mode has no Local Host origin', () => {
    expect(() => createRendererServerOptions({ NEXUSDESK_LOCAL_WEB: '1' })).toThrow(
      'NEXUSDESK_LOCAL_ORIGIN is required',
    )
  })

  it('proxies authenticated HTTP and WebSocket traffic to the same Local Host', () => {
    const server = createRendererServerOptions({
      NEXUSDESK_LOCAL_WEB: '1',
      NEXUSDESK_LOCAL_ORIGIN: 'http://127.0.0.1:43123',
    })

    expect(server.proxy).toEqual({
      '/api': { target: 'http://127.0.0.1:43123' },
      '/ws': { target: 'ws://127.0.0.1:43123', ws: true },
    })
  })
})
