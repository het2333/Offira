import { randomUUID } from 'node:crypto'

export type OfficeGatewayResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false
      readonly error: { readonly code: string; readonly message: string; readonly details: object }
    }

/** Internal only: invoke the official Connection dispatcher without opening a listener.
 * The document capability policy must run before this low-level adapter.
 * No retries: a transport failure does not prove a mutation failed.
 */
export function createOfficeGatewayFetch(handler: { fetch(request: Request): Promise<Response> }) {
  return async (
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<OfficeGatewayResult> => {
    if (!/^[a-zA-Z0-9_$-]+(?:\/[a-zA-Z0-9_$-]+)*$/.test(endpoint)) {
      throw new Error('Invalid internal Gateway endpoint.')
    }
    signal?.throwIfAborted()
    const rpcId = randomUUID()
    const response = await handler.fetch(
      new Request(`http://office.invalid/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
        ...(signal ? { signal } : {}),
      }),
    )
    if (!response.ok) throw new Error(`Internal Gateway returned HTTP ${response.status}.`)
    const message: unknown = await response.json()
    if (
      !message ||
      typeof message !== 'object' ||
      !('type' in message) ||
      message.type !== 'server-response' ||
      !('rpcId' in message) ||
      message.rpcId !== rpcId
    ) {
      throw new Error('Internal Gateway response correlation mismatch.')
    }
    const result = 'result' in message ? message.result : undefined
    if (!result || typeof result !== 'object' || !('ok' in result))
      throw new Error('Invalid Gateway result.')
    // Official Connection permits void results; JSON omits an undefined value.
    if (result.ok === true) return { ok: true, value: 'value' in result ? result.value : undefined }
    if (
      result.ok === false &&
      'error' in result &&
      result.error &&
      typeof result.error === 'object'
    ) {
      const error = result.error
      if (
        'code' in error &&
        typeof error.code === 'string' &&
        'message' in error &&
        typeof error.message === 'string' &&
        'details' in error &&
        error.details !== null &&
        typeof error.details === 'object'
      ) {
        return {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        }
      }
    }
    throw new Error('Invalid Gateway result.')
  }
}
