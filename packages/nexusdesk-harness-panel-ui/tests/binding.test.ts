import { afterEach, describe, expect, it, vi } from 'vitest'
import { installOfficePanelBinding, requireOfficePanelBinding } from '../src/binding.ts'

describe('Office panel binding', () => {
  let dispose: (() => void) | undefined

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('rejects client activation when the authenticated carrier installed no binding', () => {
    expect(() => requireOfficePanelBinding()).toThrow(/binding.*before.*boot/i)
  })

  it('exposes one installed binding and only its owner can clear it', () => {
    const binding = { sessionId: 'session-1', captureSubmission: vi.fn() }
    dispose = installOfficePanelBinding(binding)

    expect(requireOfficePanelBinding()).toBe(binding)
    expect(() =>
      installOfficePanelBinding({
        sessionId: 'session-2',
        captureSubmission: vi.fn(),
      }),
    ).toThrow(/already installed/i)

    dispose()
    dispose = undefined
    expect(() => requireOfficePanelBinding()).toThrow(/binding.*before.*boot/i)
  })

  it('rejects malformed carrier input instead of booting an unbound panel', () => {
    expect(() =>
      installOfficePanelBinding({
        sessionId: '   ',
        captureSubmission: vi.fn(),
      }),
    ).toThrow(/sessionId/i)
  })
})
