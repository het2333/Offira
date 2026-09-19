import type { IncomingMessage } from 'node:http'

import { HostError } from '@nexusdesk/office-host'

export const MAX_DOCUMENT_CONTENT_BYTES = 134_217_728

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function expectedRevision(request: IncomingMessage): number {
  const contentType = headerValue(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/octet-stream') {
    throw new HostError(
      'INVALID_REQUEST',
      'Document content writes require application/octet-stream.',
      false,
    )
  }
  const value = headerValue(request, 'if-match')
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new HostError(
      'INVALID_REQUEST',
      'Document content writes require a decimal If-Match revision.',
      false,
    )
  }
  const revision = Number(value)
  if (!Number.isSafeInteger(revision)) {
    throw new HostError('INVALID_REQUEST', 'The If-Match revision is too large.', false)
  }
  return revision
}

export async function readBinaryBody(
  request: IncomingMessage,
  limit = MAX_DOCUMENT_CONTENT_BYTES,
): Promise<Uint8Array> {
  const declaredLength = headerValue(request, 'content-length')
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new HostError('INVALID_REQUEST', 'Content-Length must be a decimal byte count.', false)
    }
    if (Number(declaredLength) > limit) {
      throw new HostError(
        'CONTENT_TOO_LARGE',
        `Document content exceeds the ${String(limit)} byte limit.`,
        false,
      )
    }
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) {
      throw new HostError(
        'CONTENT_TOO_LARGE',
        `Document content exceeds the ${String(limit)} byte limit.`,
        false,
      )
    }
    chunks.push(buffer)
  }
  return new Uint8Array(Buffer.concat(chunks, size))
}
