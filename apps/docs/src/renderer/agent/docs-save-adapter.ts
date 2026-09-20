import type { AgentSaveResult } from '@nexusdesk/protocol'
import type { FileActionContext } from '../file-actions'
import { createDocsEditorAdapter, type DocsEditorAdapterOptions } from './docs-editor-adapter'

// These are buildDocBytes' mutable inputs; the parsed source is immutable and revision-bound.
const SAVE_FIELDS = [
  'section',
  'sectionDirty',
  'sections',
  'sectionsDirty',
  'trailingStartType',
  'pgNumEdit',
  'pgNumDirtySections',
  'sectionHfEdits',
  'pendingNumbering',
  'numberingDirty',
  'styleUpserts',
  'pageColor',
  'pageColorDirty',
  'header',
  'headerDirty',
  'footer',
  'footerDirty',
  'hfVariants',
  'hfVariantsDirty',
  'titlePg',
  'titlePgDirty',
  'evenOddHf',
  'evenOddHfDirty',
  'comments',
  'commentsDirty',
  'protection',
  'protectionDirty',
  'writeProtection',
  'writeProtectionDirty',
  'removePersonalInfo',
  'removePersonalInfoDirty',
  'inkAnnotations',
  'inksDirty',
  'watermark',
  'watermarkDirty',
  'watermarkPicture',
  'watermarkStyle',
  'footnotes',
  'endnotes',
  'notesDirty',
  'sources',
  'sourcesDirty',
  'zoteroDocumentData',
  'zoteroDocumentDataDirty',
  'themeFonts',
  'themeFontsDirty',
  'themeColors',
  'themeColorsDirty',
] as const

const identities = new WeakMap<object, number>()
let nextIdentity = 0
function identity(value: object): number {
  let id = identities.get(value)
  if (id === undefined) {
    id = ++nextIdentity
    identities.set(value, id)
  }
  return id
}

function boundedSnapshot(value: unknown): string {
  let nodes = 0
  let characters = 0
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 64) throw new Error('Save snapshot complexity limit exceeded')
    if (typeof input === 'string') {
      characters += input.length
      if (characters > 4 * 1024 * 1024) throw new Error('Save snapshot size limit exceeded')
      return input
    }
    if (input === null || typeof input !== 'object') return input
    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
      characters += input.byteLength
      if (characters > 4 * 1024 * 1024) throw new Error('Save snapshot size limit exceeded')
      // Mutable added assets belong to the approval too. Original package
      // bytes are never visited (the parsed source uses revision/identity).
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input)
      return { bytes: Array.from(bytes) }
    }
    if (Array.isArray(input)) return input.map((entry) => visit(entry, depth + 1))
    if (input instanceof Map) return visit([...input], depth + 1)
    if (input instanceof Set) return visit([...input], depth + 1)
    return Object.fromEntries(
      Object.entries(input).map(([key, entry]) => [visit(key, depth + 1), visit(entry, depth + 1)]),
    )
  }
  return JSON.stringify(visit(value, 0))
}

/** Includes the full body and every serializable save setting, including non-body edits. */
export function docsSaveSnapshot(ctx: FileActionContext): string {
  if (!ctx.editor || !ctx.doc) throw new Error('the document is not ready to save')
  return boundedSnapshot({
    source: { identity: identity(ctx.doc.parsed), hash: ctx.doc.hash, filePath: ctx.doc.filePath },
    state: Object.fromEntries(SAVE_FIELDS.map((key) => [key, ctx[key]])),
    body: ctx.editor.getJSON(),
  })
}

export function createDocsSaveAdapter(options: DocsEditorAdapterOptions) {
  const saveSnapshot = (): string => {
    const ctx = options.context()
    if (!ctx.editor || !ctx.doc || !options.document().attached)
      throw new Error('the document is not ready to save')
    return JSON.stringify({ document: options.document(), content: docsSaveSnapshot(ctx) })
  }
  const adapter = createDocsEditorAdapter(options)
  return Object.assign(adapter, {
    saveSnapshot,
    async save(documentId: Parameters<typeof adapter.save>[0]): Promise<AgentSaveResult> {
      const expected = saveSnapshot()
      let stale = false
      const guarded = createDocsEditorAdapter({
        ...options,
        context: () => ({
          ...options.context(),
          approvedSaveGuard: () => {
            stale = saveSnapshot() !== expected
            return !stale
          },
        }),
      })
      const result = await guarded.save(documentId)
      return stale
        ? {
            ok: false,
            summary: 'The document changed after save approval.',
            warnings: [
              {
                code: 'STALE_CONTENT',
                message: 'Propose the save again for the current document.',
              },
            ],
          }
        : result
    },
  })
}
