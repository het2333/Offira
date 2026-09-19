import {
  PROTOCOL_VERSION,
  type AgentServerFrame,
  type ClientFrame,
  type ClientId,
} from '@nexusdesk/protocol'

export type NexusClientState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed'

export interface NexusSocketEventMap {
  open: Record<string, never>
  message: { data: string }
  close: { code: number }
  error: unknown
}

export interface NexusSocket {
  addEventListener<K extends keyof NexusSocketEventMap>(
    type: K,
    listener: (event: NexusSocketEventMap[K]) => void,
  ): void
  send(data: string): void
  close(): void
}

export interface NexusClientOptions {
  url: string
  webSocketFactory?: (url: string) => NexusSocket
  schedule?: (callback: () => void, delay: number) => unknown
  cancelSchedule?: (handle: unknown) => void
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

export type NexusClientErrorCode = 'CONNECTION_LOST' | 'CLIENT_CLOSED' | 'INVALID_SERVER_FRAME'

export class NexusClientError extends Error {
  constructor(readonly code: NexusClientErrorCode, message: string) {
    super(message)
    this.name = 'NexusClientError'
  }
}

interface PendingRequest {
  frame: ClientFrame
  resolve(frame: AgentServerFrame): void
  reject(error: NexusClientError): void
}

export interface NexusClient {
  readonly state: NexusClientState
  readonly clientId: ClientId | undefined
  connect(): void
  close(): void
  send(frame: ClientFrame): void
  request(frame: ClientFrame): Promise<AgentServerFrame>
  onFrame(listener: (frame: AgentServerFrame) => void): () => void
  onState(listener: (state: NexusClientState) => void): () => void
}

const SAFE_TO_QUEUE = new Set<ClientFrame['type']>(['editor:register', 'operation:lookup'])

function defaultSocketFactory(url: string): NexusSocket {
  return new WebSocket(url) as unknown as NexusSocket
}

function parseServerFrame(data: string): AgentServerFrame {
  const value = JSON.parse(data) as Record<string, unknown>
  if (value.protocolVersion !== PROTOCOL_VERSION || typeof value.type !== 'string') {
    throw new NexusClientError('INVALID_SERVER_FRAME', 'server frame has an unsupported protocol')
  }
  return value as unknown as AgentServerFrame
}

class BrowserNexusClient implements NexusClient {
  private currentState: NexusClientState = 'idle'
  private currentClientId: ClientId | undefined
  private socket: NexusSocket | undefined
  private reconnectAttempt = 0
  private reconnectTimer: unknown
  private readonly queued: ClientFrame[] = []
  private readonly pending = new Map<string, PendingRequest>()
  private readonly frameListeners = new Set<(frame: AgentServerFrame) => void>()
  private readonly stateListeners = new Set<(state: NexusClientState) => void>()
  private readonly socketFactory: (url: string) => NexusSocket
  private readonly schedule: (callback: () => void, delay: number) => unknown
  private readonly cancelSchedule: (handle: unknown) => void

  constructor(private readonly options: NexusClientOptions) {
    this.socketFactory = options.webSocketFactory ?? defaultSocketFactory
    this.schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay))
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => globalThis.clearTimeout(handle as number))
  }

  get state(): NexusClientState {
    return this.currentState
  }

  get clientId(): ClientId | undefined {
    return this.currentClientId
  }

  connect(): void {
    if (this.currentState !== 'idle') return
    this.setState('connecting')
    this.openSocket(false)
  }

  close(): void {
    if (this.currentState === 'closed') return
    this.setState('closed')
    if (this.reconnectTimer !== undefined) this.cancelSchedule(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.socket?.close()
    this.socket = undefined
    this.currentClientId = undefined
    const error = new NexusClientError('CLIENT_CLOSED', 'NexusDesk client is closed')
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    this.queued.length = 0
  }

  send(frame: ClientFrame): void {
    if (this.currentState === 'closed') {
      throw new NexusClientError('CLIENT_CLOSED', 'NexusDesk client is closed')
    }
    if (this.currentState === 'ready' && this.socket !== undefined) {
      this.socket.send(JSON.stringify(frame))
      return
    }
    if (SAFE_TO_QUEUE.has(frame.type)) {
      this.enqueue(frame)
      return
    }
    throw new NexusClientError('CONNECTION_LOST', `cannot send ${frame.type} while disconnected`)
  }

  request(frame: ClientFrame): Promise<AgentServerFrame> {
    if (this.pending.has(frame.id)) {
      return Promise.reject(new NexusClientError('INVALID_SERVER_FRAME', `duplicate request id ${frame.id}`))
    }
    return new Promise((resolve, reject) => {
      this.pending.set(frame.id, { frame, resolve, reject })
      try {
        this.send(frame)
      } catch (error) {
        this.pending.delete(frame.id)
        reject(error)
      }
    })
  }

  onFrame(listener: (frame: AgentServerFrame) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onState(listener: (state: NexusClientState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private openSocket(reconnecting: boolean): void {
    if (this.currentState === 'closed') return
    if (reconnecting) this.setState('reconnecting')
    const socket = this.socketFactory(this.options.url)
    this.socket = socket
    socket.addEventListener('open', () => undefined)
    socket.addEventListener('message', (event) => this.receive(socket, event.data))
    socket.addEventListener('close', () => this.disconnected(socket))
    socket.addEventListener('error', () => undefined)
  }

  private receive(socket: NexusSocket, data: string): void {
    if (socket !== this.socket || this.currentState === 'closed') return
    let frame: AgentServerFrame
    try {
      frame = parseServerFrame(data)
    } catch (error) {
      this.failInvalidFrame(error)
      return
    }
    if (frame.type === 'server:ready') {
      this.currentClientId = frame.clientId
      this.reconnectAttempt = 0
      this.setState('ready')
      for (const queued of this.queued.splice(0)) socket.send(JSON.stringify(queued))
    }
    if ('id' in frame) {
      const request = this.pending.get(frame.id)
      if (request !== undefined) {
        this.pending.delete(frame.id)
        request.resolve(frame)
      }
    }
    for (const listener of this.frameListeners) listener(frame)
  }

  private disconnected(socket: NexusSocket): void {
    if (socket !== this.socket || this.currentState === 'closed') return
    this.socket = undefined
    this.currentClientId = undefined
    for (const [id, request] of this.pending) {
      if (SAFE_TO_QUEUE.has(request.frame.type)) {
        this.enqueue(request.frame)
      } else {
        request.reject(new NexusClientError('CONNECTION_LOST', `request ${id} lost its connection`))
        this.pending.delete(id)
      }
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting')
    const base = this.options.reconnectBaseMs ?? 250
    const cap = this.options.reconnectMaxMs ?? 5_000
    const delay = Math.min(base * (2 ** this.reconnectAttempt), cap)
    this.reconnectAttempt += 1
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = undefined
      this.openSocket(true)
    }, delay)
  }

  private enqueue(frame: ClientFrame): void {
    if (!this.queued.some((queued) => queued.id === frame.id)) this.queued.push(frame)
  }

  private setState(state: NexusClientState): void {
    if (this.currentState === state) return
    this.currentState = state
    for (const listener of this.stateListeners) listener(state)
  }

  private failInvalidFrame(cause: unknown): void {
    const message = cause instanceof Error ? cause.message : 'invalid server frame'
    const error = new NexusClientError('INVALID_SERVER_FRAME', message)
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    this.close()
  }
}

export function createNexusClient(options: NexusClientOptions): NexusClient {
  return new BrowserNexusClient(options)
}
