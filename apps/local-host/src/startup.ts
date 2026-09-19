import { existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import type { EditorKind } from '@nexusdesk/office-host'

export interface StartupDocumentPath {
  editorType: Extract<EditorKind, 'docs' | 'sheets'>
  path: string
}

export function startupDocumentPaths(args: readonly string[], cwd: string): StartupDocumentPath[] {
  if (args.length === 0) {
    throw new Error(
      'Usage: npm run start:web -- /absolute/path/to/document.docx [/absolute/path/to/workbook.xlsx]',
    )
  }
  return args.map((candidate) => {
    const path = resolve(cwd, candidate)
    const extension = extname(path).toLowerCase()
    const editorType = extension === '.docx' ? 'docs' : extension === '.xlsx' ? 'sheets' : undefined
    if (editorType === undefined) {
      throw new Error('Local Web currently accepts only .docx and .xlsx document paths.')
    }
    if (!existsSync(path)) throw new Error(`Document does not exist: ${path}`)
    return { editorType, path }
  })
}

export function startupWorkbookPath(args: readonly string[], cwd: string): string {
  const [document] = startupDocumentPaths(args.slice(0, 1), cwd)
  if (document?.editorType !== 'sheets') {
    throw new Error('Local Web currently accepts one .xlsx workbook path.')
  }
  return document.path
}
