import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

interface Registration {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => {
    readonly inject: readonly string[]
    readonly apply: unknown
  }
}

describe('published Client artifact', () => {
  it('registers the package through ModuleLoader and resolves React from the shared shell', async () => {
    const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    let registration: Registration | undefined
    runInNewContext(source, {
      window: {
        __ModuleLoader__: {
          load(value: Registration) {
            registration = value
          },
        },
      },
    })
    if (registration === undefined) throw new Error('client bundle did not register itself')

    const nodeRequire = createRequire(import.meta.url)
    const requested: string[] = []
    const exports = registration.factory((specifier) => {
      requested.push(specifier)
      if (specifier === 'react' || specifier === 'react/jsx-runtime') {
        return nodeRequire(specifier)
      }
      throw new Error(`unexpected bundled external: ${specifier}`)
    })

    expect(registration.id).toBe('@nexusdesk/harness-office-panel-ui')
    expect(exports.inject).toEqual(['slots', 'sessions', 'uiSession', 'uiConversation'])
    expect(exports.apply).toEqual(expect.any(Function))
    expect([...new Set(requested)].sort()).toEqual(['react', 'react/jsx-runtime'])
  })

  it('ships public Host, binding, and Client declarations beside the bundle', async () => {
    const names = ['index.d.ts', 'binding.d.ts', 'client.d.ts']
    await expect(
      Promise.all(
        names.map((name) => readFile(new URL(`../lib/${name}`, import.meta.url), 'utf8')),
      ),
    ).resolves.toHaveLength(3)
  })
})
