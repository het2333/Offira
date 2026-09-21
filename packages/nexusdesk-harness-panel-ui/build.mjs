import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDirectory = fileURLToPath(new URL('./lib/', import.meta.url))
const clientEntry = fileURLToPath(new URL('./src/client.tsx', import.meta.url))
const typeScript = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

await mkdir(outputDirectory, { recursive: true })

await build({
  absWorkingDir: packageRoot,
  bundle: true,
  entryNames: '[name]',
  entryPoints: ['src/index.ts', 'src/binding.ts'],
  format: 'esm',
  outdir: outputDirectory,
  platform: 'neutral',
  target: 'es2022',
})

const client = await build({
  bundle: true,
  entryPoints: [clientEntry],
  external: ['react', 'react/jsx-runtime'],
  format: 'cjs',
  jsx: 'automatic',
  platform: 'browser',
  target: 'es2022',
  write: false,
})
const body = client.outputFiles[0]?.text
if (body === undefined) throw new Error('Office panel Client bundle produced no JavaScript')

const wrapped = `window.__ModuleLoader__.load({
  id: "@nexusdesk/harness-office-panel-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body
  .split('\n')
  .map((line) => (line === '' ? '' : `    ${line}`))
  .join('\n')}
    return module.exports;
  }
});
`
await writeFile(new URL('./lib/client.js', import.meta.url), wrapped)

execFileSync(process.execPath, [typeScript, '-p', 'tsconfig.build.json'], {
  cwd: packageRoot,
  stdio: 'inherit',
})
