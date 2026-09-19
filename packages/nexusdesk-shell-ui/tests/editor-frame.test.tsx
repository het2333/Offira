/**
 * @vitest-environment jsdom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { shellBootstrapSchema, shellDocumentSummarySchema } from '@nexusdesk/office-host'
import { EditorFrame, editorRoute } from '../src/EditorFrame'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const bootstrap = shellBootstrapSchema.parse({
  capabilities: {
    mode: 'browser',
    editors: ['sheets'],
    nativeFilePicker: false,
    browserImport: false,
    revealInFileManager: false,
    trash: false,
    updater: false,
    credentialStore: false,
  },
  documents: [{ documentId: 'd1', title: 'Forecast.xlsx', editorType: 'sheets', revision: 1 }],
  tabs: [
    { id: 'home', kind: 'home', title: 'Home', closable: false, active: false },
    {
      id: 'document:d1',
      kind: 'sheets',
      title: 'Forecast.xlsx',
      closable: true,
      active: true,
      documentId: 'd1',
    },
  ],
  settings: { language: 'zh', theme: 'system', onboardingSeen: true },
})

it('renders one active Sheets frame after a bootstrap refresh', () => {
  expect(editorRoute(bootstrap.documents[0]!)).toBe('/sheets/?host=local-web&documentId=d1')

  act(() => root.render(<EditorFrame bootstrap={bootstrap} />))
  expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
    '/sheets/?host=local-web&documentId=d1',
  )

  act(() => root.render(<EditorFrame bootstrap={{ ...bootstrap, tabs: [...bootstrap.tabs] }} />))
  expect(container.querySelectorAll('iframe[title="Forecast.xlsx"]')).toHaveLength(1)
})

it('routes Docs by document id and keeps every open editor frame mounted', () => {
  const docsDocument = shellDocumentSummarySchema.parse({
    documentId: 'doc 1',
    title: 'Report.docx',
    editorType: 'docs',
    revision: 1,
  })
  expect(editorRoute(docsDocument)).toBe('/docs/?host=local-web&documentId=doc%201')

  expect(
    editorRoute(shellDocumentSummarySchema.parse({ documentId: 'slides 1', title: 'Deck.pptx', editorType: 'slides', revision: 1 })),
  ).toBe('/slides/?host=local-web&documentId=slides%201')
  expect(
    editorRoute(shellDocumentSummarySchema.parse({ documentId: 'pdf 1', title: 'Review.pdf', editorType: 'pdf', revision: 1 })),
  ).toBe('/pdf/?host=local-web&documentId=pdf%201')

  const withDocs = shellBootstrapSchema.parse({
    ...bootstrap,
    capabilities: { ...bootstrap.capabilities, editors: ['docs', 'sheets'] },
    documents: [...bootstrap.documents, docsDocument],
    tabs: [
      { ...bootstrap.tabs[0], active: false },
      { ...bootstrap.tabs[1], active: true },
      {
        id: 'document:doc 1',
        kind: 'docs',
        title: 'Report.docx',
        closable: true,
        active: false,
        documentId: 'doc 1',
      },
    ],
  })
  act(() => root.render(<EditorFrame bootstrap={withDocs} />))
  const sheetsFrame = container.querySelector('iframe[title="Forecast.xlsx"]')
  const docsFrame = container.querySelector('iframe[title="Report.docx"]')
  expect(sheetsFrame).not.toBeNull()
  expect(docsFrame).not.toBeNull()
  expect(docsFrame?.getAttribute('aria-hidden')).toBe('true')

  act(() =>
    root.render(
      <EditorFrame
        bootstrap={{
          ...withDocs,
          tabs: withDocs.tabs.map((tab) => ({
            ...tab,
            active: tab.kind === 'docs',
          })),
        }}
      />,
    ),
  )
  expect(container.querySelector('iframe[title="Forecast.xlsx"]')).toBe(sheetsFrame)
  expect(container.querySelector('iframe[title="Report.docx"]')).toBe(docsFrame)
  expect(sheetsFrame?.getAttribute('aria-hidden')).toBe('true')
  expect(docsFrame?.getAttribute('aria-hidden')).toBe('false')
})

it('routes Markdown and HTML documents by document id', () => {
  expect(
    editorRoute({ documentId: 'markdown 1', title: 'Notes.md', editorType: 'markdown', revision: 1 } as never),
  ).toBe('/markdown/?host=local-web&documentId=markdown%201')
  expect(
    editorRoute({ documentId: 'html 1', title: 'Page.html', editorType: 'html', revision: 1 } as never),
  ).toBe('/html/?host=local-web&documentId=html%201')
})

it('keeps the same Sheets frame mounted across Home and close/reopen transitions', () => {
  act(() => root.render(<EditorFrame bootstrap={bootstrap} />))
  const frame = container.querySelector('iframe')
  expect(frame).not.toBeNull()

  const homeBootstrap = {
    ...bootstrap,
    tabs: bootstrap.tabs.map((tab) => ({ ...tab, active: tab.kind === 'home' })),
  }
  act(() => root.render(<EditorFrame bootstrap={homeBootstrap} />))
  expect(container.querySelector('iframe')).toBe(frame)
  expect(frame?.getAttribute('aria-hidden')).toBe('true')

  const closedBootstrap = {
    ...bootstrap,
    tabs: bootstrap.tabs
      .filter((tab) => tab.kind === 'home')
      .map((tab) => ({ ...tab, active: true })),
  }
  act(() => root.render(<EditorFrame bootstrap={closedBootstrap} />))
  expect(container.querySelector('iframe')).toBe(frame)

  act(() => root.render(<EditorFrame bootstrap={bootstrap} />))
  expect(container.querySelector('iframe')).toBe(frame)
  expect(frame?.getAttribute('aria-hidden')).toBe('false')
})
