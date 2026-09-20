/** Conservative inline limits below Local Host's 2,000,000-byte JSON boundary.
 * No PDF tool advertises large-image upload until a binary blob contract exists.
 */
export const PDF_WEB_IMAGE_BASE64_LIMIT = 512 * 1024
export const PDF_WEB_SAVE_JSON_LIMIT = 1_500_000

export class PdfPayloadTooLargeError extends Error {
  readonly code = 'PDF_PAYLOAD_TOO_LARGE'
  constructor(message: string) {
    super(message)
    this.name = 'PdfPayloadTooLargeError'
  }
}

export function assertPdfWebPayload(value: unknown): void {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    for (const [key, item] of Object.entries(node)) {
      if (key === 'image' && typeof item === 'string' && item.length > PDF_WEB_IMAGE_BASE64_LIMIT)
        throw new PdfPayloadTooLargeError(
          'Local Web PDF images must be at most 512 KiB of base64 (384 KiB decoded). Resize or compress the image before editing.',
        )
      visit(item)
    }
  }
  visit(value)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PDF_WEB_SAVE_JSON_LIMIT)
    throw new PdfPayloadTooLargeError(
      'The pending PDF save exceeds the 1,500,000-byte inline limit. Save existing edits before adding more content.',
    )
}
