import { describe, expect, it } from 'vitest'
import {
  assertPdfWebPayload,
  PDF_WEB_IMAGE_BASE64_LIMIT,
  PDF_WEB_SAVE_JSON_LIMIT,
} from '../src/pdf-limits'

describe('PDF inline payload contract', () => {
  it('accepts the exact per-image boundary and rejects the next base64 quantum', () => {
    expect(() =>
      assertPdfWebPayload({ image: 'A'.repeat(PDF_WEB_IMAGE_BASE64_LIMIT) }),
    ).not.toThrow()
    expect(() =>
      assertPdfWebPayload({ image: 'A'.repeat(PDF_WEB_IMAGE_BASE64_LIMIT + 4) }),
    ).toThrow(expect.objectContaining({ code: 'PDF_PAYLOAD_TOO_LARGE' }))
  })
  it('bounds aggregate UTF-8 JSON, not each image in isolation', () => {
    const image = 'A'.repeat(PDF_WEB_IMAGE_BASE64_LIMIT)
    expect(() => assertPdfWebPayload({ imageEdits: [{ image }, { image }] })).not.toThrow()
    expect(() => assertPdfWebPayload({ imageEdits: [{ image }, { image }, { image }] })).toThrow(
      /pending PDF save/,
    )
    expect(() => assertPdfWebPayload({ text: '中'.repeat(PDF_WEB_SAVE_JSON_LIMIT / 3) })).toThrow(
      /pending PDF save/,
    )
  })
})
