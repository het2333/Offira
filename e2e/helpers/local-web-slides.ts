import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { openPptx } from '@genoffice/pptx-engine'

import { DocumentDriverRegistry } from '../../apps/local-host/src/document-driver'
import { createSlidesDocumentDriver } from '../../apps/local-host/src/slides-document-driver'
import { startLocalHost } from '../../apps/local-host/src/server'

export async function launchSlidesLocalWebHost() {
  const repositoryRoot = process.cwd()
  if (!existsSync(resolve(repositoryRoot, 'apps/web/dist/index.html')) || !existsSync(resolve(repositoryRoot, 'apps/slides/out/web/index.html'))) {
    execFileSync('npm', ['run', 'build:web'], { cwd: repositoryRoot, stdio: 'inherit' })
  }
  const directory = await mkdtemp(join(tmpdir(), 'nexusdesk-local-web-slides-e2e-'))
  const path = join(directory, 'Deck.pptx')
  await copyFile(resolve(repositoryRoot, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'), path)
  const driver = await createSlidesDocumentDriver(path)
  let applyCount = 0
  const countedDriver = {
    ...driver,
    async execute(action: string, payload: unknown) {
      if (action === 'slides:apply-txn') applyCount += 1
      return driver.execute(action, payload)
    },
  }
  const running = await startLocalHost({
    staticAssets: {
      webRoot: resolve(repositoryRoot, 'apps/web/dist'),
      editorRoots: { slides: resolve(repositoryRoot, 'apps/slides/out/web') },
    },
    documentDrivers: new DocumentDriverRegistry([countedDriver]),
    runtimeCommand: { entry: resolve(repositoryRoot, 'e2e/fixtures/fake-slides-harness.mjs') },
  })
  return {
    ...running,
    documentId: driver.document.documentId,
    async readApplyCount() { return applyCount },
    async readPersistedText() {
      const opened = await openPptx(await readFile(path))
      return opened.deck.slides.flatMap((slide) => slide.elements.flatMap((element) =>
        'text' in element && element.text !== undefined
          ? element.text.paragraphs.flatMap((paragraph) => paragraph.runs.map((run) => run.text))
          : [],
      ))
    },
    async close() {
      await running.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
