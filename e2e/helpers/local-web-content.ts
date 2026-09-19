import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createTextDocumentDriver } from '../../apps/local-host/src/text-document-driver'
import { DocumentDriverRegistry } from '../../apps/local-host/src/document-driver'
import { startLocalHost } from '../../apps/local-host/src/server'

export async function launchContentLocalWeb(editorType: 'markdown' | 'html') {
  const root = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), `nexusdesk-${editorType}-e2e-`))
  const name = editorType === 'markdown' ? 'Notes.md' : 'Page.html'
  const path = join(directory, name)
  const recoveryPath = join(directory, `.${name}.nexusdesk-recovery.json`)
  const countPath = join(directory, 'apply-count.json')
  await writeFile(path, editorType === 'markdown' ? '# Initial\n' : '<h1>Initial</h1>')
  const driver = await createTextDocumentDriver(path, editorType)
  const running = await startLocalHost({
    documentDrivers: new DocumentDriverRegistry([driver]),
    staticAssets: {
      webRoot: resolve(root, 'apps/web/dist'),
      editorRoots: {
        markdown: resolve(root, 'apps/markdown/out/web'),
        html: resolve(root, 'apps/html/out/web'),
      },
    },
    runtimeCommand: { entry: resolve(root, 'e2e/fixtures/fake-content-harness-runtime.mjs'), args: [countPath] },
  })
  return {
    ...running,
    name,
    async readText() { return readFile(path, 'utf8') },
    async readApplyCount() { return JSON.parse(await readFile(countPath, 'utf8')) as { applyCount: number } },
    async hasRecovery() { try { await access(recoveryPath); return true } catch { return false } },
    async close() { await running.close(); await rm(directory, { recursive: true, force: true }) },
  }
}
