import { expect, it, vi } from 'vitest'
import { isApprovedSaveLocked, lockApprovedSave } from '../src/renderer/approved-save-lock'
import type { UniverRuntime } from '../src/renderer/univer-state'

it('vetoes delayed and nested commands, restores editing, and cleans the command stack by identity', () => {
  let listener: ((command: { id: string }) => void) | undefined
  const dispose = vi.fn(() => {
    listener = undefined
  })
  const parent = { id: 'parent' }
  const stack = [parent]
  const service = {
    _commandExecutionStack: stack,
    beforeCommandExecuted: (fn: typeof listener) => {
      listener = fn
      return { dispose }
    },
  }
  const runtime = {
    univer: { __getInjector: () => ({ get: () => service }) },
  } as unknown as UniverRuntime
  const root = { inert: false }
  vi.stubGlobal('document', { body: root })
  try {
    const release = lockApprovedSave(runtime)
    expect(isApprovedSaveLocked(runtime)).toBe(true)
    expect(root.inert).toBe(true)
    const mutation = { id: 'sheet.mutation.set-range-values' }
    stack.push(mutation)
    expect(() => listener!(mutation)).toThrow(/approved save/i)
    expect(stack).toEqual([parent])
    expect(() => lockApprovedSave(runtime)).toThrow(/already in progress/)
    release()
    release()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(isApprovedSaveLocked(runtime)).toBe(false)
    expect(root.inert).toBe(false)
    expect(listener).toBeUndefined()
  } finally {
    vi.unstubAllGlobals()
  }
})
