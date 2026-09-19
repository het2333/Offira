import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ShellDocumentSummary } from '@nexusdesk/office-host'
import { ShellState } from '../src/shell-state'

let directory: string | undefined

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function statePath(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'nexusdesk-shell-state-'))
  return join(directory, 'shell.json')
}

const workbook = {
  documentId: 'document-1',
  title: 'Forecast.xlsx',
  editorType: 'sheets',
  revision: 0,
} as ShellDocumentSummary

describe('ShellState', () => {
  it('keeps one home tab and one tab per registered document across page refreshes', async () => {
    const path = await statePath()
    const state = await ShellState.open({ path, documents: [workbook] })
    await state.activate(`document:${workbook.documentId}`)

    const reopened = await ShellState.open({ path, documents: [workbook] })

    expect(reopened.bootstrap().tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'home', kind: 'home' }),
        expect.objectContaining({ documentId: workbook.documentId, active: true }),
      ]),
    )
  })

  it('persists a closed document without reopening it on process restart', async () => {
    const path = await statePath()
    const state = await ShellState.open({ path, documents: [workbook] })
    await state.close(`document:${workbook.documentId}`)

    const reopened = await ShellState.open({ path, documents: [workbook] })

    expect(reopened.bootstrap().tabs).toEqual([
      expect.objectContaining({ id: 'home', active: true }),
    ])
  })

  it('recovers from corrupt persisted state with safe defaults', async () => {
    const path = await statePath()
    await writeFile(path, '{not-json')

    const state = await ShellState.open({ path, documents: [workbook] })

    expect(state.bootstrap().tabs).toEqual([
      expect.objectContaining({ id: 'home', active: true }),
      expect.objectContaining({ documentId: workbook.documentId, active: false }),
    ])
  })

  it('serializes concurrent mutations without losing fields or racing persistence', async () => {
    const path = await statePath()
    const state = await ShellState.open({ path, documents: [workbook] })

    await expect(
      Promise.all([
        state.updateSettings({ language: 'en' }),
        state.updateSettings({ theme: 'dark' }),
      ]),
    ).resolves.toHaveLength(2)

    const reopened = await ShellState.open({ path, documents: [workbook] })
    expect(reopened.bootstrap().settings).toMatchObject({ language: 'en', theme: 'dark' })
  })
})
