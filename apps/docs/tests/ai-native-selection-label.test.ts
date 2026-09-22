import { afterEach, expect, test, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(AI_PROVIDERS.map((provider) => [provider.id, { apiKey: '', model: provider.defaultModel }])) as AiSettings['providers'],
}

afterEach(() => {
  delete (window as any).nexusdeskDocsHost
  vi.unstubAllGlobals()
})

test('native Docs panel shows the selected paragraph range and word count without a text preview', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', attrs: { docxIndex: 0 }, content: [{ type: 'text', text: '第一段选中文字测试' }] }] },
  })
  const client = { state: 'disconnected', onState: () => () => {}, onFrame: () => () => {} }
  ;(window as any).nexusdeskDocsHost = {
    document: { documentId: 'doc-a', revision: 1 },
    bridge: { transportClient: () => client, client: () => ({ clientId: undefined, attached: false }) },
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(AiPanel, { editor, blocks: [], settings, open: true })))
    await act(async () => editor.commands.setTextSelection({ from: 1, to: 4 }))
    expect(container.querySelector('.native-harness-scope')?.textContent).toContain('第 1–1 段 · 3 字')
    expect(container.querySelector('.native-harness-scope-preview')).toBeNull()
    await act(async () => editor.commands.setTextSelection({ from: 4, to: 8 }))
    expect(container.querySelector('.native-harness-scope')?.textContent).toContain('第 1–1 段 · 4 字')
    await act(async () => editor.commands.setTextSelection(8))
    expect(container.querySelector('.native-harness-scope')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    editor.destroy()
  }
})

test('native Docs panel shows a zero-word range when selected text is only whitespace', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', attrs: { docxIndex: 0 }, content: [{ type: 'text', text: '　 ' }] }] },
  })
  const client = { state: 'disconnected', onState: () => () => {}, onFrame: () => () => {} }
  ;(window as any).nexusdeskDocsHost = {
    document: { documentId: 'doc-a', revision: 1 },
    bridge: { transportClient: () => client, client: () => ({ clientId: undefined, attached: false }) },
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(AiPanel, { editor, blocks: [], settings, open: true })))
    await act(async () => editor.commands.setTextSelection({ from: 1, to: 3 }))
    expect(container.querySelector('.native-harness-scope')?.textContent).toContain('第 1–1 段 · 0 字')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    editor.destroy()
  }
})
