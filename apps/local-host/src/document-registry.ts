import type {
  ClientId,
  DocumentId,
  RendererInstanceId,
  Revision,
} from '@nexusdesk/protocol'

export type DocumentRegistryErrorCode =
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_DETACHED'
  | 'WRONG_CLIENT'
  | 'WRONG_EDITOR'
  | 'WRONG_RENDERER'
  | 'STALE_REVISION'
  | 'NON_MONOTONIC_REVISION'

export class DocumentRegistryError extends Error {
  constructor(readonly code: DocumentRegistryErrorCode, message: string) {
    super(message)
    this.name = 'DocumentRegistryError'
  }
}

export interface DocumentRegistration {
  documentId: DocumentId
  clientId: ClientId
  rendererInstanceId?: RendererInstanceId
  editorType: string
  revision: Revision
}

export interface AuthorizedDocument {
  documentId: string
  editorType: string
  revision: number
}

interface AttachedDocument extends DocumentRegistration {
  attached: true
}

interface DetachedDocument {
  documentId: DocumentId
  editorType: string
  revision: Revision
  rendererInstanceId?: RendererInstanceId
  attached: false
}

type DocumentRecord = AttachedDocument | DetachedDocument

export interface DocumentOwnerCheck {
  documentId: DocumentId
  clientId: ClientId
  revision: Revision
}

/** Owns the authoritative browser client and revision for every open document. */
export class DocumentRegistry {
  private documents = new Map<DocumentId, DocumentRecord>()

  constructor(documents: readonly AuthorizedDocument[] = []) {
    this.initialize(documents)
  }

  initialize(documents: readonly AuthorizedDocument[]): void {
    const initialized = new Map<DocumentId, DocumentRecord>()
    for (const document of documents) {
      const documentId = document.documentId as DocumentId
      if (initialized.has(documentId)) {
        throw new Error(`duplicate authorized document ${document.documentId}`)
      }
      initialized.set(documentId, {
        documentId,
        editorType: document.editorType,
        revision: document.revision as Revision,
        attached: false,
      })
    }
    this.documents = initialized
  }

  refreshFromHost(
    document: AuthorizedDocument,
    rendererInstanceId?: RendererInstanceId,
  ): void {
    const documentId = document.documentId as DocumentId
    const current = this.documents.get(documentId)
    if (current === undefined) {
      throw new DocumentRegistryError(
        'DOCUMENT_NOT_FOUND',
        `document ${document.documentId} is not authorized`,
      )
    }
    if (current.attached) {
      if (current.editorType !== document.editorType) {
        throw new DocumentRegistryError(
          'WRONG_EDITOR',
          `document ${document.documentId} is attached to editor ${current.editorType}`,
        )
      }
      if (document.revision <= current.revision) return
      const refreshed: AttachedDocument = {
        ...current,
        revision: document.revision as Revision,
      }
      this.documents.set(documentId, refreshed)
      return
    }
    if (
      rendererInstanceId !== undefined &&
      current.rendererInstanceId === rendererInstanceId
    ) return
    const refreshed: DetachedDocument = {
      documentId,
      editorType: document.editorType,
      revision: document.revision as Revision,
      attached: false,
    }
    this.documents.set(documentId, refreshed)
  }

  register(registration: DocumentRegistration): AttachedDocument {
    const current = this.documents.get(registration.documentId)
    if (current === undefined) {
      throw new DocumentRegistryError(
        'DOCUMENT_NOT_FOUND',
        `document ${registration.documentId} is not authorized`,
      )
    }
    if (current.editorType !== registration.editorType) {
      throw new DocumentRegistryError(
        'WRONG_EDITOR',
        `document ${registration.documentId} requires editor ${current.editorType}`,
      )
    }
    if (current.revision !== registration.revision) {
      throw new DocumentRegistryError(
        'STALE_REVISION',
        `document ${registration.documentId} is revision ${String(current.revision)}, not ${String(registration.revision)}`,
      )
    }
    if (current.attached) {
      if (current.clientId !== registration.clientId) {
        throw new DocumentRegistryError(
          'WRONG_CLIENT',
          `document ${registration.documentId} belongs to another browser client`,
        )
      }
      if (current.rendererInstanceId !== registration.rendererInstanceId) {
        throw new DocumentRegistryError(
          'WRONG_RENDERER',
          `document ${registration.documentId} belongs to another renderer instance`,
        )
      }
      return current
    }
    const record: AttachedDocument = { ...registration, attached: true }
    this.documents.set(registration.documentId, record)
    return record
  }

  assertOwner(check: DocumentOwnerCheck): AttachedDocument {
    const record = this.assertClient(check.documentId, check.clientId)
    if (record.revision !== check.revision) {
      throw new DocumentRegistryError(
        'STALE_REVISION',
        `document ${check.documentId} is revision ${String(record.revision)}, not ${String(check.revision)}`,
      )
    }
    return record
  }

  assertClient(documentId: DocumentId, clientId: ClientId): AttachedDocument {
    const record = this.documents.get(documentId)
    if (record === undefined) {
      throw new DocumentRegistryError('DOCUMENT_NOT_FOUND', `document ${documentId} is not registered`)
    }
    if (!record.attached) {
      throw new DocumentRegistryError('DOCUMENT_DETACHED', `document ${documentId} has no browser client`)
    }
    if (record.clientId !== clientId) {
      throw new DocumentRegistryError('WRONG_CLIENT', `document ${documentId} belongs to another browser client`)
    }
    return record
  }

  commitRevision(update: DocumentOwnerCheck): AttachedDocument {
    const record = this.documents.get(update.documentId)
    if (record === undefined) {
      throw new DocumentRegistryError('DOCUMENT_NOT_FOUND', `document ${update.documentId} is not registered`)
    }
    if (!record.attached) {
      throw new DocumentRegistryError('DOCUMENT_DETACHED', `document ${update.documentId} has no browser client`)
    }
    if (record.clientId !== update.clientId) {
      throw new DocumentRegistryError('WRONG_CLIENT', `document ${update.documentId} belongs to another browser client`)
    }
    if (update.revision === record.revision) return record
    if (update.revision !== record.revision + 1) {
      throw new DocumentRegistryError(
        'NON_MONOTONIC_REVISION',
        `document ${update.documentId} revision must advance from ${String(record.revision)} to ${String(record.revision + 1)}`,
      )
    }
    const next: AttachedDocument = { ...record, revision: update.revision }
    this.documents.set(update.documentId, next)
    return next
  }

  detach(check: Pick<DocumentOwnerCheck, 'documentId' | 'clientId'>): boolean {
    const record = this.documents.get(check.documentId)
    if (record === undefined) {
      throw new DocumentRegistryError(
        'DOCUMENT_NOT_FOUND',
        `document ${check.documentId} is not registered`,
      )
    }
    if (!record.attached) return false
    if (record.clientId !== check.clientId) {
      throw new DocumentRegistryError(
        'WRONG_CLIENT',
        `document ${check.documentId} belongs to another browser client`,
      )
    }
    this.documents.set(check.documentId, {
      documentId: check.documentId,
      editorType: record.editorType,
      revision: record.revision,
      ...(record.rendererInstanceId === undefined
        ? {}
        : { rendererInstanceId: record.rendererInstanceId }),
      attached: false,
    })
    return true
  }

  detachClient(clientId: ClientId): number {
    let detached = 0
    for (const [documentId, record] of this.documents) {
      if (!record.attached || record.clientId !== clientId) continue
      this.documents.set(documentId, {
        documentId,
        editorType: record.editorType,
        revision: record.revision,
        ...(record.rendererInstanceId === undefined
          ? {}
          : { rendererInstanceId: record.rendererInstanceId }),
        attached: false,
      })
      detached += 1
    }
    return detached
  }
}
