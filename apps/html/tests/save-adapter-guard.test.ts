import { expect, it } from 'vitest'
import { createHtmlEditorAdapter } from '../src/renderer/agent/html-editor-adapter'

it('revalidates the approved version after an asynchronous save wait', async () => {
  let version = 1
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  let writes = 0
  const adapter = createHtmlEditorAdapter({
    document: () => ({
      documentId: 'document-1' as never,
      clientId: 'client-1' as never,
      revision: 1 as never,
      contentVersion: version,
      title: 'Document',
      attached: true,
    }),
    saveContent: () => 'approved body',
    read: () => ({ ok: true, summary: 'read', warnings: [] }),
    apply: async () => ({ ok: true, summary: 'applied', warnings: [] }),
    consumeApproval: () => true,
    save: async (guard) => {
      await gate
      if (guard?.() === false) return { ok: false, summary: 'stale', warnings: [] }
      writes++
      return { ok: true, summary: 'saved', warnings: [] }
    },
  })
  const saving = adapter.save('document-1' as never)
  version++
  resume()
  await expect(saving).resolves.toMatchObject({ ok: false, warnings: [{ code: 'STALE_CONTENT' }] })
  expect(writes).toBe(0)
})

it('includes complete save text even when contentVersion is unchanged', () => {
  let text = 'Approved body and envelope'
  const adapter = createHtmlEditorAdapter({
    document: () => ({
      documentId: 'document-1' as never,
      clientId: 'client-1' as never,
      revision: 1 as never,
      contentVersion: 1,
      title: 'Document',
      attached: true,
    }),
    saveContent: () => text,
    read: () => ({ ok: true, summary: 'read', warnings: [] }),
    apply: async () => ({ ok: true, summary: 'applied', warnings: [] }),
    consumeApproval: () => true,
    save: async () => ({ ok: true, summary: 'saved', warnings: [] }),
  }) as ReturnType<typeof createHtmlEditorAdapter> & { saveSnapshot(): string }
  const original = adapter.saveSnapshot()
  text = 'Different body with the same version'
  expect(adapter.saveSnapshot()).not.toBe(original)
})
