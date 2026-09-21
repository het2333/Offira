import { resolve } from 'node:path'

import { nexusdeskAppDataDirectory } from './app-data'
import { DocumentDriverRegistry } from './document-driver'
import { createDocsDocumentDriver } from './docs-document-driver'
import { createPdfDocumentDriver } from './pdf-document-driver'
import { createSlidesDocumentDriver } from './slides-document-driver'
import { startLocalHost } from './server'
import { createSheetsDocumentService } from './sheets-document-service'
import { startupDocumentPaths } from './startup'
import { createTextDocumentDriver } from './text-document-driver'

const repositoryRoot = process.cwd()
const runtimePackage = resolve(repositoryRoot, 'packages/nexusdesk-runtime-host')
const startupDocuments = startupDocumentPaths(process.argv.slice(2), repositoryRoot)
const drivers = []
for (const startup of startupDocuments) {
  if (startup.editorType === 'docs') {
    drivers.push(await createDocsDocumentDriver(startup.path))
  } else if (startup.editorType === 'slides') {
    drivers.push(await createSlidesDocumentDriver(startup.path))
  } else if (startup.editorType === 'sheets') {
    const sheets = await createSheetsDocumentService(repositoryRoot, startup.path)
    drivers.push(...sheets.drivers)
  } else if (startup.editorType === 'pdf') {
    drivers.push(await createPdfDocumentDriver(startup.path))
  } else {
    drivers.push(await createTextDocumentDriver(startup.path, startup.editorType))
  }
}
const running = await startLocalHost({
  shellStatePath: resolve(nexusdeskAppDataDirectory(), 'shell-state.json'),
  staticAssets: {
    webRoot: resolve(process.cwd(), 'apps/web/dist'),
    editorRoots: {
      docs: resolve(process.cwd(), 'apps/docs/out/web'),
      sheets: resolve(process.cwd(), 'apps/sheets/out/web'),
      slides: resolve(process.cwd(), 'apps/slides/out/web'),
      pdf: resolve(process.cwd(), 'apps/pdf/out/web'),
      markdown: resolve(process.cwd(), 'apps/markdown/out/web'),
      html: resolve(process.cwd(), 'apps/html/out/web'),
    },
  },
  runtimeCommand: {
    entry: resolve(runtimePackage, 'lib/index.mjs'),
    args: [
      repositoryRoot,
      resolve(runtimePackage, 'profile'),
      'runtime',
      `--state-dir=${resolve(nexusdeskAppDataDirectory(), 'harness-runtime')}`,
    ],
  },
  documentDrivers: new DocumentDriverRegistry(drivers),
})
process.stdout.write(`${JSON.stringify({ bootstrapUrl: running.bootstrapUrl })}\n`)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void running.close().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
