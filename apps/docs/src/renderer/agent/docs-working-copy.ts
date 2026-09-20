import type { BrowserWorkingCopyPayload } from '@nexusdesk/web-client'
import { buildDocBytes, type FileActionContext } from '../file-actions'
import { waitForFullContent } from '../phased-content'
import { docsSaveSnapshot } from './docs-save-adapter'

export interface DocsWorkingCopyCaptureOptions {
  /** Flushes the renderer's pending React updates before reading its current context. */
  settle?(): void | Promise<void>
  serialize?: typeof buildDocBytes
}

/** Captures the serializer's entire state, including side parts and immutable source identity. */
export async function captureDocsWorkingCopy(
  context: () => FileActionContext,
  options: DocsWorkingCopyCaptureOptions = {},
): Promise<BrowserWorkingCopyPayload> {
  await waitForFullContent()
  window.dispatchEvent(new Event('ai-docs-commit-tables'))
  await options.settle?.()
  const current = context()
  const before = docsSaveSnapshot(current)
  const bytes = await (options.serialize ?? buildDocBytes)(current)
  await options.settle?.()
  if (docsSaveSnapshot(context()) !== before) {
    throw Object.assign(
      new Error('The complete document changed while its checkpoint was captured.'),
      { code: 'STALE_CONTENT' },
    )
  }
  if (!bytes) throw new Error('The document is not ready for a checkpoint.')
  return { kind: 'docx-bytes', parts: new Map([['document', new Blob([new Uint8Array(bytes)])]]) }
}
