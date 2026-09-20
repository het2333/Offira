import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repositoryRoot = process.cwd()

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npm', ['run', 'build:web'])
run(process.execPath, [
  resolve(repositoryRoot, 'node_modules/@playwright/test/cli.js'),
  'test',
  'e2e/local-web-sheets-agent.spec.ts',
  'e2e/local-web-docs-agent.spec.ts',
  'e2e/local-web-slides.spec.ts',
  'e2e/production-runtime-slides.spec.ts',
  'e2e/local-web-pdf-agent.spec.ts',
  'e2e/local-web-pdf-real-runtime.spec.ts',
  'e2e/local-web-markdown-agent.spec.ts',
  'e2e/local-web-html-agent.spec.ts',
  '--project=chromium',
  ...process.argv.slice(2),
])
