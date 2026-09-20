import { expect, it } from 'vitest'
import { createHtmlEditorAdapter } from '../src/renderer/agent/html-editor-adapter'

it('revalidates the approved version after an asynchronous save wait', async () => {
  let version = 1
  let resume!: () => void
  const gate = new Promise<void>((resolve) => { resume = resolve })
  let writes = 0
  const adapter = createHtmlEditorAdapter({
    document: () => ({ documentId: 'document-1' as never, clientId: 'client-1' as never, revision: 1 as never, contentVersion: version, title: 'Document', attached: true }),
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

