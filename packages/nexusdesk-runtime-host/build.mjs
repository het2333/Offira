import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(here, 'lib/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})

await build({
  entryPoints: [join(here, 'src/slides-tools.ts')],
  outfile: join(here, 'lib/slides-tools.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
