import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import JSZip from 'jszip'

import { DocumentDriverRegistry } from '../../apps/local-host/src/document-driver'
import { createDocsDocumentDriver } from '../../apps/local-host/src/docs-document-driver'
import { startLocalHost } from '../../apps/local-host/src/server'

export async function launchDocsLocalWebHost() {
  const repositoryRoot = process.cwd()
  if (
    !existsSync(resolve(repositoryRoot, 'apps/web/dist/index.html')) ||
    !existsSync(resolve(repositoryRoot, 'apps/docs/out/web/index.html'))
  ) {
    execFileSync('npm', ['run', 'build:web'], { cwd: repositoryRoot, stdio: 'inherit' })
  }

  const directory = await mkdtemp(join(tmpdir(), 'nexusdesk-local-web-docs-e2e-'))
  const path = join(directory, 'nexusdesk-docs-source.docx')
  const applyCountPath = join(directory, 'apply-count.json')
  await copyFile(
    resolve(repositoryRoot, 'apps/docs/tests/pagination-corpus/docx/fixture-simple.docx'),
    path,
  )
  const driver = await createDocsDocumentDriver(path)
  const running = await startLocalHost({
    staticAssets: {
      webRoot: resolve(repositoryRoot, 'apps/web/dist'),
      editorRoots: {
        docs: resolve(repositoryRoot, 'apps/docs/out/web'),
        sheets: resolve(repositoryRoot, 'apps/sheets/out/web'),
      },
    },
    documentDrivers: new DocumentDriverRegistry([driver]),
    runtimeCommand: {
      entry: resolve(repositoryRoot, 'e2e/fixtures/fake-docs-harness-runtime.mjs'),
      args: [applyCountPath],
    },
  })

  return {
    ...running,
    documentId: driver.document.documentId,
    async readApplyCount() {
      const value = JSON.parse(await readFile(applyCountPath, 'utf8')) as { applyCount: number }
      return value.applyCount
    },
    async readDocumentText() {
      const zip = await JSZip.loadAsync(await readFile(path))
      const xml = await zip.file('word/document.xml')!.async('string')
      return xml.replace(/<[^>]+>/g, '')
    },
    async close() {
      await running.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
