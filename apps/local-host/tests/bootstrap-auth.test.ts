import { describe, expect, it } from 'vitest'

import { createBootstrapAuth } from '../src/bootstrap-auth'

function deterministicBytes(fill: number): (size: number) => Uint8Array {
  return (size) => new Uint8Array(size).fill(fill)
}

describe('createBootstrapAuth', () => {
  it('exchanges its bootstrap token exactly once', () => {
    const auth = createBootstrapAuth(deterministicBytes(7), () => 1_000)

    const first = auth.exchange(auth.token)
    expect(first).toEqual({
      ok: true,
      sessionId: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      cookie: 'nexusdesk_session=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc; HttpOnly; SameSite=Strict; Path=/',
    })
    expect(auth.exchange(auth.token)).toEqual({ ok: false })
  })

  it('does not consume the token when a different value is presented', () => {
    const auth = createBootstrapAuth(deterministicBytes(9), () => 1_000)

    expect(auth.exchange('not-the-token')).toEqual({ ok: false })
    expect(auth.exchange(auth.token).ok).toBe(true)
  })

  it('rejects a token after sixty seconds', () => {
    let now = 1_000
    const auth = createBootstrapAuth(deterministicBytes(11), () => now)
    now += 60_001

    expect(auth.exchange(auth.token)).toEqual({ ok: false })
  })
})
