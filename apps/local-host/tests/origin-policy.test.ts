import { describe, expect, it } from 'vitest'

import { acceptHttpOrigin, acceptWebSocketOrigin } from '../src/origin-policy'

function req(host: string | undefined, origin?: string) {
  return { headers: { ...(host === undefined ? {} : { host }), ...(origin === undefined ? {} : { origin }) } }
}

const expectedOrigin = 'http://127.0.0.1:43123'

describe('acceptHttpOrigin', () => {
  it('accepts an exact loopback authority without an Origin for top-level navigation', () => {
    expect(acceptHttpOrigin(req('127.0.0.1:43123'), expectedOrigin)).toBe(true)
  })

  it('rejects a DNS alias and a mismatched port', () => {
    expect(acceptHttpOrigin(req('localhost:43123'), expectedOrigin)).toBe(false)
    expect(acceptHttpOrigin(req('127.0.0.1:43124'), expectedOrigin)).toBe(false)
  })
})

describe('acceptWebSocketOrigin', () => {
  it('accepts only the exact bound host and browser origin', () => {
    expect(acceptWebSocketOrigin(req('127.0.0.1:43123', expectedOrigin), expectedOrigin)).toBe(true)
    expect(acceptWebSocketOrigin(req('evil.example', 'https://evil.example'), expectedOrigin)).toBe(false)
    expect(acceptWebSocketOrigin(req('localhost:43123', expectedOrigin), expectedOrigin)).toBe(false)
  })

  it('rejects absent, null, LAN, and mismatched-port origins', () => {
    expect(acceptWebSocketOrigin(req('127.0.0.1:43123'), expectedOrigin)).toBe(false)
    expect(acceptWebSocketOrigin(req('127.0.0.1:43123', 'null'), expectedOrigin)).toBe(false)
    expect(acceptWebSocketOrigin(req('192.168.1.5:43123', 'http://192.168.1.5:43123'), expectedOrigin)).toBe(false)
    expect(acceptWebSocketOrigin(req('127.0.0.1:43123', 'http://127.0.0.1:43124'), expectedOrigin)).toBe(false)
  })
})
