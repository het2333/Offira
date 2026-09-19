import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface ServiceReply {
  id?: unknown
  ok?: unknown
  value?: unknown
  error?: unknown
}

interface Pending {
  resolve(value: unknown): void
  reject(reason: Error): void
}

function serviceEntry(): { path: string; execArgv: string[] } {
  const roots = [process.cwd(), resolve(process.cwd(), '..'), resolve(process.cwd(), '../..')]
  const root = roots.find((candidate) => existsSync(join(candidate, 'apps/slides')))
  if (root === undefined) throw new Error('Unable to locate the NexusDesk apps directory for Slides Local Web.')
  const appsDirectory = resolve(root, 'apps')
  const built = resolve(appsDirectory, 'slides/out/slides-web-service.mjs')
  if (existsSync(built)) return { path: built, execArgv: [] }
  return {
    path: resolve(appsDirectory, 'slides/src/main/slides-web-service.ts'),
    execArgv: ['--import', 'tsx'],
  }
}

/** Fixed Local Host transport for the Electron-free Slides state service. */
export class SlidesWebServiceClient {
  readonly #child: ChildProcess
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #closed = false

  private constructor() {
    const entry = serviceEntry()
    this.#child = fork(entry.path, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      execArgv: entry.execArgv,
    })
    this.#child.on('message', (message: unknown) => this.#receive(message))
    this.#child.once('error', (error) => this.#failAll(error))
    this.#child.once('exit', (code, signal) => {
      if (!this.#closed) this.#failAll(new Error(`Slides service exited (${String(code ?? signal)}).`))
    })
  }

  static async open(bytes: Uint8Array, title: string): Promise<SlidesWebServiceClient> {
    const client = new SlidesWebServiceClient()
    try {
      await client.request('init', { bytes, title })
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  request(action: string, payload: unknown): Promise<unknown> {
    if (this.#closed || !this.#child.connected) return Promise.reject(new Error('Slides service is closed.'))
    const id = this.#nextId++
    return new Promise<unknown>((resolveRequest, reject) => {
      this.#pending.set(id, { resolve: resolveRequest, reject })
      this.#child.send({ id, action, payload }, (error) => {
        if (error !== null && error !== undefined) {
          const pending = this.#pending.get(id)
          this.#pending.delete(id)
          pending?.reject(error)
        }
      })
    })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    try {
      if (this.#child.connected) await this.request('close', {})
    } catch {
      // The parent owns no state that requires a graceful child shutdown.
    } finally {
      this.#closed = true
      this.#failAll(new Error('Slides service is closed.'))
      this.#child.disconnect()
      this.#child.kill()
    }
  }

  #receive(message: unknown): void {
    const reply = message as ServiceReply
    if (typeof reply.id !== 'number' || typeof reply.ok !== 'boolean') return
    const pending = this.#pending.get(reply.id)
    if (pending === undefined) return
    this.#pending.delete(reply.id)
    if (reply.ok) pending.resolve(reply.value)
    else pending.reject(new Error(typeof reply.error === 'string' ? reply.error : 'Slides service request failed.'))
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}
