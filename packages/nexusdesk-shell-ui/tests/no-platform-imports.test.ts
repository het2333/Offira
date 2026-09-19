import { readdir, readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

import { expect, it } from 'vitest'

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
    }),
  )
  return nested.flat()
}

it('contains no Electron global or privileged import', async () => {
  const root = resolve(import.meta.dirname, '../src')
  const sources = await Promise.all((await sourceFiles(root)).map((path) => readFile(path, 'utf8')))

  expect(sources.join('\n')).not.toMatch(
    /window\.(?:aiOffice|aiOfficeTabs|aiOfficeIntegrations)|from ['"]electron['"]|node:/,
  )
})
