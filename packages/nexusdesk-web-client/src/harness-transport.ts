import type {
  DocumentId,
  HarnessClientFrame,
  HarnessServerFrame,
  RequestId,
  Revision,
} from '@nexusdesk/protocol'
import type { NexusClient } from './client'

type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }
type Snapshot = { revision: Revision; selection: unknown }
interface Pending {
  resolve(frame: HarnessServerFrame): void
  reject(error: Error): void
}
interface Stream {
  values: unknown[]
  bytes: number
  wake?: (() => void) | undefined
  done: boolean
  error?: Error
}

/** Native Connection RPC over the editor's existing authenticated socket; never replays requests. */
export function createHarnessTransport(client: NexusClient, documentId: DocumentId) {
  const pending = new Map<string, Pending>()
  const streams = new Map<string, Stream>()
  const snapshots = new Map<string, Snapshot>()
  const capturedRequests = new Set<string>()
  let disposed = false
  const id = () => crypto.randomUUID() as RequestId
  const base = () => ({ protocolVersion: 1 as const, id: id(), documentId })
  const assertReady = () => {
    if (disposed || client.state !== 'ready')
      throw new Error('与本地服务的连接不可用，请恢复连接后检查操作结果。')
  }
  const rejectAll = (error: Error) => {
    for (const item of pending.values()) item.reject(error)
    pending.clear()
    snapshots.clear()
    for (const stream of streams.values()) {
      stream.error = error
      stream.done = true
      stream.wake?.()
    }
  }
  const sendCancel = (streamId: string) => {
    if (!disposed && client.state === 'ready') {
      try {
        client.send({ ...base(), type: 'harness:stream-cancel', streamId })
      } catch {
        /* disconnect already invalidates this stream */
      }
    }
  }
  const offFrames = client.onFrame((frame) => {
    if (
      !frame.type.startsWith('harness:') ||
      !('documentId' in frame) ||
      frame.documentId !== documentId ||
      !('id' in frame)
    )
      return
    const native = frame as HarnessServerFrame
    const request = pending.get(native.id)
    if (request) {
      pending.delete(native.id)
      if (native.type === 'harness:error') request.reject(new Error(native.message))
      else request.resolve(native)
      return
    }
    const stream = streams.get(native.id)
    if (!stream || stream.done) return
    if (native.type === 'harness:stream-item') {
      const bytes = new TextEncoder().encode(JSON.stringify(native.value)).byteLength
      if (stream.values.length >= 256 || stream.bytes + bytes > 2 * 1024 * 1024) {
        stream.error = new Error('会话更新超过缓冲上限，请重新连接。')
        stream.done = true
        stream.values.length = 0
        sendCancel(native.id)
      } else {
        stream.values.push(native.value)
        stream.bytes += bytes
      }
    } else if (native.type === 'harness:stream-end') stream.done = true
    else if (native.type === 'harness:error') {
      stream.error = new Error(native.message)
      stream.done = true
    }
    stream.wake?.()
  })
  const offState = client.onState((state) => {
    if (state !== 'ready') rejectAll(new Error('与本地服务的连接已中断，操作结果尚未核实。'))
  })

  async function request(
    frame: HarnessClientFrame,
    signal?: AbortSignal,
  ): Promise<HarnessServerFrame> {
    assertReady()
    signal?.throwIfAborted()
    if (pending.size >= 128) throw new Error('待响应的会话请求过多，请等待已有请求完成。')
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(frame.id)
        cleanup()
        reject(new Error('请求已取消；已发送操作的结果仍需核实。'))
      }
      const timer = setTimeout(() => {
        pending.delete(frame.id)
        cleanup()
        reject(new Error('本地服务响应超时，操作结果尚未核实；请检查文件，不要重复提交修改。'))
      }, 30_000)
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      pending.set(frame.id, {
        resolve(value) {
          cleanup()
          resolve(value)
        },
        reject(error) {
          cleanup()
          reject(error)
        },
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        client.send(frame)
      } catch (error) {
        pending.delete(frame.id)
        cleanup()
        reject(error)
      }
    })
  }

  const rpc = {
    async call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<RpcResult> {
      if (channel !== '/api') throw new Error('不支持此会话通道。')
      if (endpoint === 'session/prompt') {
        const requestId = (payload as { args?: { request?: { requestId?: unknown } } } | null)?.args
          ?.request?.requestId
        if (typeof requestId !== 'string' || !snapshots.has(requestId))
          throw new Error('未捕获本次提交的文档选区，请重新发起。')
        const snapshot = snapshots.get(requestId)!
        snapshots.delete(requestId)
        const prepared = await request(
          { ...base(), type: 'harness:prepare', requestId, ...snapshot },
          signal,
        )
        if (prepared.type !== 'harness:prepared' || prepared.requestId !== requestId)
          throw new Error('提交上下文未获确认。')
      }
      const response = await request({ ...base(), type: 'harness:rpc', endpoint, payload }, signal)
      if (response.type !== 'harness:result') throw new Error('会话返回类型不匹配。')
      const result = response.result as RpcResult
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean')
        throw new Error('无效的会话结果。')
      return result
    },
    async *open(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal: AbortSignal,
    ): AsyncGenerator<unknown> {
      if (channel !== '/api') throw new Error('不支持此会话通道。')
      assertReady()
      signal.throwIfAborted()
      if (streams.size >= 16) throw new Error('会话连接数量超限。')
      const frame = { ...base(), type: 'harness:stream-open' as const, endpoint, payload }
      const stream: Stream = { values: [], bytes: 0, done: false }
      streams.set(frame.id, stream)
      const abort = () => {
        stream.error = new Error('会话订阅已取消。')
        stream.done = true
        stream.wake?.()
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        client.send(frame)
        while (true) {
          if (stream.error) throw stream.error
          if (stream.values.length) {
            const value = stream.values.shift()
            stream.bytes -= new TextEncoder().encode(JSON.stringify(value)).byteLength
            yield value
          } else if (stream.done) return
          else
            await new Promise<void>((resolve) => {
              stream.wake = resolve
            })
        }
      } finally {
        signal.removeEventListener('abort', abort)
        streams.delete(frame.id)
        sendCancel(frame.id)
      }
    },
  }
  return {
    rpc,
    async bind(): Promise<string> {
      const response = await request({ ...base(), type: 'harness:bind' })
      if (response.type !== 'harness:bound') throw new Error('文档会话未能建立。')
      return response.sessionId
    },
    captureSubmission(requestId: string, snapshot: Snapshot): void {
      assertReady()
      if (!requestId || capturedRequests.has(requestId) || capturedRequests.size >= 10000 || snapshots.size >= 128)
        throw new Error('无效或重复的提交上下文。')
      snapshots.set(requestId, structuredClone(snapshot))
      capturedRequests.add(requestId)
    },
    dispose(): void {
      if (disposed) return
      for (const streamId of streams.keys()) sendCancel(streamId)
      disposed = true
      rejectAll(new Error('文档会话已关闭。'))
      offFrames()
      offState()
    },
  }
}
