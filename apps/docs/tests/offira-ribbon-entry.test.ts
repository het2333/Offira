// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { expect, test, vi } from 'vitest'
import { Ribbon } from '../src/renderer/components/Ribbon'
import { computeFormatState } from '../src/renderer/components/ribbon-format-state'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { ribbonProps } from './helpers/ribbon-props'

test.each([true, false])('Docs ribbon uses the correct AI identity for Web=%s and keeps toggle behavior', async (web) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions, content: '<p>Hello</p>' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onToggleAi = vi.fn()
  try {
    const props = {
      ...ribbonProps(editor, computeFormatState(editor)),
      nativeCapabilities: web ? { openFile: false, saveInPlace: true, saveAs: false, encryption: false, print: false, zotero: false, externalAttachments: false, nativeProviderSettings: false } as const : undefined,
      onToggleAi,
    }
    await act(async () => root.render(createElement(Ribbon, props)))
    const button = container.querySelector<HTMLButtonElement>('.ribbon-body .rb-big.ai-entry')!
    expect(button).not.toBeNull()
    expect(button.textContent).toBe(web ? 'Offira AI' : 'Genspark AI')
    expect(button.querySelector('img') instanceof HTMLImageElement).toBe(web)
    await act(async () => button.click())
    expect(onToggleAi).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    editor.destroy()
    container.remove()
    vi.unstubAllGlobals()
  }
})
