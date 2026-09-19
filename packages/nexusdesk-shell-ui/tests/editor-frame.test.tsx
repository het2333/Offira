/**
 * @vitest-environment jsdom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { shellBootstrapSchema } from '@nexusdesk/office-host'
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
