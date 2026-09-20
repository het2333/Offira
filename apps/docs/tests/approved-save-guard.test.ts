import { expect, it, vi } from 'vitest'
import { save, type FileActionContext } from '../src/renderer/file-actions'

it('does not serialize a changed approved document after waiting for pending content', async () => {
  const getJSON = vi.fn(() => {
    throw Error('unapproved content was read')
  })
  const ctx = {
    editor: { getJSON, state: { doc: {}, selection: { from: 0 } } },
    doc: { filePath: '/tmp/approved.docx', parsed: { blocks: [] } },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    setStatus() {},
    approvedSaveGuard: () => false,
  } as unknown as FileActionContext
  await expect(save(ctx, false, true)).resolves.toBe(false)
  expect(getJSON).not.toHaveBeenCalled()
})
