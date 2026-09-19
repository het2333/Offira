import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
      recoveryUrl: `/api/documents/${driver.document.documentId}/recovery`,
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

  it('rejects non-UTF-8 bytes introduced by an external disk change', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexusdesk-text-driver-'))
    const path = join(directory, 'Page.html')
    await writeFile(path, '<h1>Initial</h1>')
    const driver = await createTextDocumentDriver(path, 'html')

    await writeFile(path, new Uint8Array([0xc3, 0x28]))

    await expect(driver.readContent!()).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_CONTENT',
    })
    expect(driver.document.revision).toBe(1)
  })

  it('keeps unsaved HTML preview bytes in the Host instead of writing them to disk', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexusdesk-text-driver-'))
    const path = join(directory, 'Page.html')
    await writeFile(path, '<h1>Saved</h1>')
    const driver = await createTextDocumentDriver(path, 'html')

    await driver.writePreview!(new TextEncoder().encode('<h1>Live preview</h1>'))

    await expect(driver.readPreview!()).resolves.toEqual({
      bytes: new TextEncoder().encode('<h1>Live preview</h1>'),
      contentType: 'text/html; charset=utf-8',
    })
    expect(await readFile(path, 'utf8')).toBe('<h1>Saved</h1>')
  })

  it('recovers an unsaved working copy after recreating the driver and clears it on save', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexusdesk-text-driver-'))
    const path = join(directory, 'Notes.md')
    const recoveryPath = join(directory, '.Notes.md.nexusdesk-recovery.json')
    await writeFile(path, '# Saved\n')
    const first = await createTextDocumentDriver(path, 'markdown')

    await (first as typeof first & {
      writeRecovery(bytes: Uint8Array, expectedRevision: number): Promise<void>
    }).writeRecovery(new TextEncoder().encode('# Unsaved\n'), 1)

    expect(await readFile(path, 'utf8')).toBe('# Saved\n')
    expect(JSON.parse(await readFile(recoveryPath, 'utf8'))).toMatchObject({
      version: 2,
      editorType: 'markdown',
      content: '# Unsaved\n',
    })

    const reopened = await createTextDocumentDriver(path, 'markdown')
    await expect(reopened.readContent!()).resolves.toEqual({
      bytes: new TextEncoder().encode('# Unsaved\n'),
      contentType: 'text/markdown; charset=utf-8',
    })

    await reopened.writeContent!(new TextEncoder().encode('# Committed\n'), 1)
    await expect(readFile(recoveryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const afterSave = await createTextDocumentDriver(path, 'markdown')
    await expect(afterSave.readContent!()).resolves.toEqual({
      bytes: new TextEncoder().encode('# Committed\n'),
      contentType: 'text/markdown; charset=utf-8',
    })
  })

  it('discards a recovery sidecar when the on-disk baseline changes', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexusdesk-text-driver-'))
    const path = join(directory, 'Page.html')
    const recoveryPath = join(directory, '.Page.html.nexusdesk-recovery.json')
    await writeFile(path, '<h1>Saved</h1>')
    const first = await createTextDocumentDriver(path, 'html')
    await (first as typeof first & {
      writeRecovery(bytes: Uint8Array, expectedRevision: number): Promise<void>
    }).writeRecovery(new TextEncoder().encode('<h1>Unsaved</h1>'), 1)

    await writeFile(path, '<h1>External</h1>')
    const reopened = await createTextDocumentDriver(path, 'html')

    await expect(reopened.readContent!()).resolves.toEqual({
      bytes: new TextEncoder().encode('<h1>External</h1>'),
      contentType: 'text/html; charset=utf-8',
    })
    await expect(readFile(recoveryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards recovery after an offline ABA replacement restores the same bytes', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexusdesk-text-driver-'))
    const path = join(directory, 'Notes.md')
    const replacementPath = join(directory, 'replacement.md')
    const recoveryPath = join(directory, '.Notes.md.nexusdesk-recovery.json')
    await writeFile(path, '# Saved\n')
    const first = await createTextDocumentDriver(path, 'markdown')
    await first.writeRecovery!(new TextEncoder().encode('# Unsaved\n'), 1)

    await writeFile(path, '# External\n')
    await writeFile(replacementPath, '# Saved\n')
    await rename(replacementPath, path)
    const reopened = await createTextDocumentDriver(path, 'markdown')

    await expect(reopened.readContent!()).resolves.toEqual({
      bytes: new TextEncoder().encode('# Saved\n'),
      contentType: 'text/markdown; charset=utf-8',
    })
    await expect(readFile(recoveryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
