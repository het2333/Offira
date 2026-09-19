import { existsSync, statSync } from 'node:fs'

import { HostError, type EditorKind, type FileSummary } from '@nexusdesk/office-host'

export interface AuthorizedDocument {
  readonly documentId: string
  readonly title: string
  readonly editorType: EditorKind
  readonly revision: number
  readonly path?: string
}

export interface AuthorizedFile extends AuthorizedDocument {
  readonly fileId: string
  readonly path: string
}

export class AuthorizedFiles {
  private readonly files = new Map<string, AuthorizedFile>()
  private readonly starred = new Set<string>()

  constructor(documents: readonly AuthorizedDocument[]) {
    for (const document of documents) {
      if (document.path === undefined) continue
      this.files.set(document.documentId, {
        ...document,
        fileId: document.documentId,
        path: document.path,
      })
    }
  }

  require(fileId: string): AuthorizedFile {
    const file = this.files.get(fileId)
    if (file === undefined) {
      throw new HostError('FILE_NOT_AUTHORIZED', `File is not authorized: ${fileId}`, false)
    }
    return file
  }

  list(): readonly FileSummary[] {
    return [...this.files.values()].map((file) => {
      const exists = existsSync(file.path)
      const stat = exists ? statSync(file.path) : undefined
      return {
        fileId: file.fileId,
        name: file.title,
        editorType: file.editorType,
        modifiedAt: stat?.mtimeMs ?? 0,
        sizeBytes: stat?.size ?? 0,
        starred: this.starred.has(file.fileId),
        ...(exists ? {} : { missing: true }),
      }
    })
  }

  toggleStar(fileId: string): readonly FileSummary[] {
    this.require(fileId)
    if (this.starred.has(fileId)) this.starred.delete(fileId)
    else this.starred.add(fileId)
    return this.list()
  }
}
