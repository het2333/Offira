import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createTextDocumentDriver } from '../src/text-document-driver'

let directory: string | undefined

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('text Local Host driver', () => {
  it('serves an authorized Markdown file and persists a revision-checked in-place edit', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexusdesk-text-driver-'))
    const path = join(directory, 'Notes.md')
    await writeFile(path, '# Initial\n')
    const driver = await createTextDocumentDriver(path, 'markdown')

    expect(await driver.bootstrap('http://127.0.0.1:43123')).toEqual({
      documentId: driver.document.documentId,
      title: basename(path),
      revision: 1,
      websocketUrl: 'ws://127.0.0.1:43123/ws',
      language: 'en',
      theme: 'system',
      contentUrl: `/api/documents/${driver.document.documentId}/content`,
    })
    expect(await driver.readContent!()).toEqual({
      bytes: new TextEncoder().encode('# Initial\n'),
      contentType: 'text/markdown; charset=utf-8',
    })

    await expect(driver.writeContent!(new TextEncoder().encode('# Updated\n'), 0)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    })
    await expect(driver.writeContent!(new TextEncoder().encode('# Updated\n'), 1)).resolves.toMatchObject({
      documentId: driver.document.documentId,
      editorType: 'markdown',
      revision: 2,
    })
    expect(await readFile(path, 'utf8')).toBe('# Updated\n')
  })

  it('rejects non-UTF-8 bytes without replacing the authorized text file', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexusdesk-text-driver-'))
    const path = join(directory, 'Page.html')
    await writeFile(path, '<h1>Initial</h1>')
    const driver = await createTextDocumentDriver(path, 'html')

    await expect(driver.writeContent!(new Uint8Array([0xc3, 0x28]), 1)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_CONTENT',
    })
    expect(await readFile(path, 'utf8')).toBe('<h1>Initial</h1>')
    expect(driver.document.revision).toBe(1)
  })
})
