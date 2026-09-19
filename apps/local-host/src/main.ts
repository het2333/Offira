import { resolve } from 'node:path'

import { nexusdeskAppDataDirectory } from './app-data'
import { DocumentDriverRegistry } from './document-driver'
import { startLocalHost } from './server'
import { createSheetsDocumentService } from './sheets-document-service'
import { startupWorkbookPath } from './startup'

const repositoryRoot = process.cwd()
const runtimePackage = resolve(repositoryRoot, 'packages/nexusdesk-runtime-host')
const workbookPath = startupWorkbookPath(process.argv.slice(2), repositoryRoot)
const sheets = await createSheetsDocumentService(repositoryRoot, workbookPath)
const running = await startLocalHost({
  shellStatePath: resolve(nexusdeskAppDataDirectory(), 'shell-state.json'),
  staticAssets: {
    webRoot: resolve(process.cwd(), 'apps/web/dist'),
    editorRoots: {
      sheets: resolve(process.cwd(), 'apps/sheets/out/web'),
    },
  },
  runtimeCommand: {
    entry: resolve(runtimePackage, 'lib/index.mjs'),
    args: [repositoryRoot, resolve(runtimePackage, 'profile'), 'runtime'],
  },
  documentDrivers: new DocumentDriverRegistry(sheets.drivers),
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
