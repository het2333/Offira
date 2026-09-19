import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_BYTES = 32
const TOKEN_TTL_MS = 60_000

type RandomBytes = (size: number) => Uint8Array
type Clock = () => number

export type BootstrapExchange =
  | { ok: true; sessionId: string; cookie: string }
  | { ok: false }

export interface BootstrapAuth {
  readonly token: string
  exchange(candidate: string): BootstrapExchange
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function matches(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected)
  const candidateBytes = Buffer.from(candidate)
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes)
}

/** Create one short-lived bootstrap credential and its one-use exchange. */
export function createBootstrapAuth(
  randomBytes: RandomBytes = nodeRandomBytes,
  now: Clock = Date.now,
): BootstrapAuth {
  const token = encode(randomBytes(TOKEN_BYTES))
  const expiresAt = now() + TOKEN_TTL_MS
  let consumed = false

  return {
    token,
    exchange(candidate) {
      if (consumed || now() > expiresAt || !matches(token, candidate)) return { ok: false }
      consumed = true
      const sessionId = encode(randomBytes(TOKEN_BYTES))
      return {
        ok: true,
        sessionId,
        cookie: `nexusdesk_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
      }
    },
  }
}
