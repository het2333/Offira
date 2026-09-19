/** Capabilities implemented by the authorized Local Host PDF driver. */
export const PDF_WEB_CAPABILITIES = {
  saveInPlace: true,
  annotationEditing: true,
  imageEditing: true,
  pageRewriting: true,
  textReflow: false,
  nativeFileDialogs: false,
  saveAs: false,
  permanentRedaction: false,
  print: false,
  conversion: false,
} as const

export type PdfCapabilities = { [K in keyof typeof PDF_WEB_CAPABILITIES]: boolean }

export function pdfCapabilities(web?: Partial<PdfCapabilities>): PdfCapabilities {
  // Desktop has the full preload contract. A Web host must explicitly advertise support.
  return Object.fromEntries(
    Object.keys(PDF_WEB_CAPABILITIES).map((key) => [
      key,
      web === undefined || web[key as keyof PdfCapabilities] === true,
    ]),
  ) as PdfCapabilities
}

export type PdfPageModification =
  | { action: 'insertBlankPage'; afterPageIndex: number }
  | { action: 'setPageSize'; width: number; height: number }
  | { action: 'cropPages'; pages: number[]; rect: { l: number; t: number; r: number; b: number } }

export function describePdfPageModification(op: PdfPageModification): string {
  if (op.action === 'insertBlankPage')
    return op.afterPageIndex < 0
      ? 'insert a blank page at the front'
      : `insert a blank page after page ${op.afterPageIndex + 1}`
  if (op.action === 'setPageSize') return `resize all pages to ${op.width} × ${op.height} points`
  return `crop pages ${op.pages.map((p) => p + 1).join(', ')} to fractions ${op.rect.l}, ${op.rect.t}, ${op.rect.r}, ${op.rect.b}`
}

/** Validate without clamping: approval must describe exactly what will be executed. */
export function parsePdfPageModification(value: unknown, pageCount: number): PdfPageModification {
  const v = value as Record<string, unknown> | null
  if (!v || typeof v !== 'object') throw new Error('Invalid PDF page modification')
  if (
    v.action === 'insertBlankPage' &&
    Number.isInteger(v.afterPageIndex) &&
    Number(v.afterPageIndex) >= -1 &&
    Number(v.afterPageIndex) < pageCount
  ) {
    return { action: v.action, afterPageIndex: Number(v.afterPageIndex) }
  }
  if (
    v.action === 'setPageSize' &&
    [v.width, v.height].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 14400,
    )
  ) {
    return { action: v.action, width: Number(v.width), height: Number(v.height) }
  }
  if (
    v.action === 'cropPages' &&
    Array.isArray(v.pages) &&
    v.pages.length > 0 &&
    new Set(v.pages).size === v.pages.length &&
    v.pages.every((n) => Number.isInteger(n) && n >= 0 && n < pageCount)
  ) {
    const r = v.rect as { l: number; t: number; r: number; b: number } | undefined
    if (
      r &&
      [r.l, r.t, r.r, r.b].every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1,
      ) &&
      r.l < r.r &&
      r.t < r.b
    ) {
      return { action: v.action, pages: [...v.pages], rect: { l: r.l, t: r.t, r: r.r, b: r.b } }
    }
  }
  throw new Error(
    'Invalid PDF page modification: check page indices, dimensions, or crop fractions',
  )
}
