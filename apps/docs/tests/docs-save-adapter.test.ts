import { Editor } from '@tiptap/core'
import { afterEach, expect, it } from 'vitest'
import { createDocsSaveAdapter } from '../src/renderer/agent/docs-save-adapter'
import { editorExtensions } from '../src/renderer/editor/extensions'
import type { FileActionContext } from '../src/renderer/file-actions'

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

it('covers non-body save settings and revalidates them after serialization yields', async () => {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Approved text' }] }],
    },
  })
  editors.push(editor)
  const ctx = {
    editor,
    doc: {
      parsed: { blocks: [] },
      filePath: '/tmp/approved.docx',
      fileName: 'approved.docx',
      hash: 'source',
    },
    header: { text: 'Approved header' },
  } as unknown as FileActionContext
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  let writes = 0
  const adapter = createDocsSaveAdapter({
    context: () => ctx,
    document: () => ({
      documentId: 'document-1' as never,
      clientId: 'client-1' as never,
      revision: 1 as never,
      title: 'approved.docx',
      attached: true,
    }),
    consumeApproval: () => true,
    execute: async (context) => {
      await gate
      if (context.approvedSaveGuard?.() === false) return { ok: false, error: 'stale' }
      writes++
      return { ok: true, result: {} }
    },
  })
  const snapshot = adapter.saveSnapshot()
  const saving = adapter.save('document-1' as never)
  ctx.header = { text: 'Changed header' }
  expect(adapter.saveSnapshot()).not.toBe(snapshot)
  resume()
  await expect(saving).resolves.toMatchObject({ ok: false, warnings: [{ code: 'STALE_CONTENT' }] })
  expect(writes).toBe(0)
})
