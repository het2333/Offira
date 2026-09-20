import type { AgentSaveResult } from '@nexusdesk/protocol'
import { createDocsEditorAdapter, type DocsEditorAdapterOptions } from './docs-editor-adapter'

/** Includes the full body and every serializable save setting, including non-body edits. */
export function createDocsSaveAdapter(options: DocsEditorAdapterOptions) {
  const saveSnapshot = (): string => {
    const ctx = options.context()
    if (!ctx.editor || !ctx.doc || !options.document().attached)
      throw new Error('the document is not ready to save')
    const state = Object.fromEntries(
      Object.entries(ctx).filter(
        ([key, value]) => key !== 'editor' && !key.endsWith('Ref') && typeof value !== 'function',
      ),
    )
    return JSON.stringify(
      { document: options.document(), state, body: ctx.editor.getJSON() },
      (_key, value) =>
        value instanceof Map ? [...value] : value instanceof Set ? [...value] : value,
    )
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
