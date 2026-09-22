import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'

import { nexusdeskAppDataDirectory } from './app-data'
import { DocumentDriverRegistry } from './document-driver'
import { createDocsDocumentDriver } from './docs-document-driver'
import { createPdfDocumentDriver } from './pdf-document-driver'
import { createSlidesDocumentDriver } from './slides-document-driver'
import { startLocalHost } from './server'
import { prepareLegacyProviderEnvironment } from './model-credential-ref'
import { createSheetsDocumentService } from './sheets-document-service'
import { startupDocumentPaths } from './startup'
import { createTextDocumentDriver } from './text-document-driver'

const providerEnvPath = resolve(nexusdeskAppDataDirectory(), 'providers.env')
const legacyProviderKeys = existsSync(providerEnvPath)
  ? prepareLegacyProviderEnvironment(parseEnv(readFileSync(providerEnvPath, 'utf8')), process.env)
  : {}
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
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
  localAccess: true,
  shellStatePath: resolve(nexusdeskAppDataDirectory(), 'shell-state.json'),
  staticAssets: {
    webRoot: resolve(repositoryRoot, 'apps/web/dist'),
    editorRoots: {
      docs: resolve(repositoryRoot, 'apps/docs/out/web'),
      sheets: resolve(repositoryRoot, 'apps/sheets/out/web'),
      slides: resolve(repositoryRoot, 'apps/slides/out/web'),
      pdf: resolve(repositoryRoot, 'apps/pdf/out/web'),
      markdown: resolve(repositoryRoot, 'apps/markdown/out/web'),
      html: resolve(repositoryRoot, 'apps/html/out/web'),
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
  legacyProviderKeys,
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
