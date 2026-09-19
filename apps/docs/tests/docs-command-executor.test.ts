import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'

import { editorExtensions } from '../src/renderer/editor/extensions'
import type { FileActionContext } from '../src/renderer/file-actions'
import { executeDocsCommand } from '../src/renderer/agent/docs-command-executor'

const liveEditors: Editor[] = []

function paragraph(text: string) {
  return {
    type: 'docParagraph',
    attrs: { docxIndex: null },
    content: [{ type: 'text', text }],
  }
}

function context(): FileActionContext {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: [paragraph('Original text.')] },
  })
  liveEditors.push(editor)
  return {
    editor,
    doc: {
      parsed: { blocks: [] },
      filePath: 'nexusdesk://document-1',
      fileName: 'Example.docx',
      hash: 'hash-1',
      isBlank: false,
    },
  } as unknown as FileActionContext
}

afterEach(() => {
  for (const editor of liveEditors.splice(0)) editor.destroy()
})

describe('Docs command executor', () => {
  it('reads the live document without MCP message objects', async () => {
    const result = await executeDocsCommand(context(), 'read_document', { scope: 'document' })

    expect(result).toMatchObject({
      ok: true,
      result: {
        blocks: [{ index: 0, type: 'p', text: 'Original text.' }],
      },
    })
  })

  it('applies the existing Docs operation DSL without MCP message objects', async () => {
    const ctx = context()
    const result = await executeDocsCommand(ctx, 'apply_ops', {
      ops: [{ op: 'findReplace', find: 'Original', replace: 'Approved' }],
    })

    expect(result).toMatchObject({ ok: true, result: { mutated: true } })
    expect(ctx.editor?.state.doc.textContent).toBe('Approved text.')
  })

  it('normalizes executor errors without exposing the built-in tool name', async () => {
    const result = await executeDocsCommand(context(), 'apply_ops', { ops: 'not-an-array' })

    expect(result).toMatchObject({ ok: false, error: expect.any(String) })
    if (!result.ok) expect(result.error).not.toContain('get_document_context')
  })
})
