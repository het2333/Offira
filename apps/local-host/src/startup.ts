import { existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'

export function startupWorkbookPath(args: readonly string[], cwd: string): string {
  const candidate = args[0]
  if (candidate === undefined) {
    throw new Error('Usage: npm run start:web -- /absolute/path/to/workbook.xlsx')
  }
  const path = resolve(cwd, candidate)
  if (extname(path).toLowerCase() !== '.xlsx') {
    throw new Error('Local Web currently accepts one .xlsx workbook path.')
  }
  if (!existsSync(path)) throw new Error(`Workbook does not exist: ${path}`)
  return path
}
