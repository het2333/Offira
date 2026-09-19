import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startupDocumentPaths, startupWorkbookPath } from '../src/startup'

let directory: string | undefined

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('Local Web production startup', () => {
  it('requires one existing XLSX path and resolves it for the production document service', async () => {
    const currentDirectory = await mkdtemp(join(tmpdir(), 'nexusdesk-startup-'))
    directory = currentDirectory
    const workbook = join(currentDirectory, 'Forecast.xlsx')
    await writeFile(workbook, 'fixture')

    expect(startupWorkbookPath([workbook], '/unused')).toBe(workbook)
    expect(() => startupWorkbookPath([], currentDirectory)).toThrow(/npm run start:web --/)
    expect(() =>
      startupWorkbookPath([join(currentDirectory, 'missing.xlsx')], currentDirectory),
    ).toThrow(/does not exist/)
    expect(() =>
      startupWorkbookPath([join(currentDirectory, 'notes.txt')], currentDirectory),
    ).toThrow(/\.xlsx/)
  })

  it('classifies office and Markdown startup paths without accepting other files', async () => {
    const currentDirectory = await mkdtemp(join(tmpdir(), 'nexusdesk-startup-'))
    directory = currentDirectory
    const docx = join(currentDirectory, 'Report.docx')
    const xlsx = join(currentDirectory, 'Forecast.xlsx')
    const markdown = join(currentDirectory, 'Notes.md')
    const text = join(currentDirectory, 'notes.txt')
    await Promise.all([
      writeFile(docx, 'fixture'),
      writeFile(xlsx, 'fixture'),
      writeFile(markdown, '# Notes'),
      writeFile(text, 'x'),
    ])

    expect(startupDocumentPaths([docx, xlsx, markdown], '/unused')).toEqual([
      { editorType: 'docs', path: docx },
      { editorType: 'sheets', path: xlsx },
      { editorType: 'markdown', path: markdown },
    ])
    expect(() => startupDocumentPaths([], currentDirectory)).toThrow(/npm run start:web --/)
    expect(() => startupDocumentPaths([text], currentDirectory)).toThrow(/\.docx.*\.xlsx.*\.md/i)
    expect(() =>
      startupDocumentPaths([join(currentDirectory, 'missing.docx')], currentDirectory),
    ).toThrow(/does not exist/)
  })
})
