export interface HeaderRequest {
  headers: {
    host?: string | string[]
    origin?: string | string[]
  }
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function exactAuthority(request: HeaderRequest, expectedOrigin: string): boolean {
  let expected: URL
  try {
    expected = new URL(expectedOrigin)
  } catch {
    return false
  }
  if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || expected.port === '') {
    return false
  }
  return oneHeader(request.headers.host) === expected.host
}

/** Top-level HTTP navigation may omit Origin but never the exact Host authority. */
export function acceptHttpOrigin(request: HeaderRequest, expectedOrigin: string): boolean {
  if (!exactAuthority(request, expectedOrigin)) return false
  const origin = oneHeader(request.headers.origin)
  return origin === undefined || origin === expectedOrigin
}

/** WebSocket upgrades require both the exact Host and browser Origin. */
export function acceptWebSocketOrigin(request: HeaderRequest, expectedOrigin: string): boolean {
  return exactAuthority(request, expectedOrigin)
    && oneHeader(request.headers.origin) === expectedOrigin
}
