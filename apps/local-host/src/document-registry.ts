import type { ClientId, DocumentId, Revision } from '@nexusdesk/protocol'

export type DocumentRegistryErrorCode =
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_DETACHED'
  | 'WRONG_CLIENT'
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
  editorType: string
  revision: Revision
}

interface AttachedDocument extends DocumentRegistration {
  attached: true
}

interface DetachedDocument {
  documentId: DocumentId
  editorType: string
  revision: Revision
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
  private readonly documents = new Map<DocumentId, DocumentRecord>()

  register(registration: DocumentRegistration): AttachedDocument {
    const record: AttachedDocument = { ...registration, attached: true }
    this.documents.set(registration.documentId, record)
    return record
  }

  assertOwner(check: DocumentOwnerCheck): AttachedDocument {
    const record = this.documents.get(check.documentId)
    if (record === undefined) {
      throw new DocumentRegistryError('DOCUMENT_NOT_FOUND', `document ${check.documentId} is not registered`)
    }
    if (!record.attached) {
      throw new DocumentRegistryError('DOCUMENT_DETACHED', `document ${check.documentId} has no browser client`)
    }
    if (record.clientId !== check.clientId) {
      throw new DocumentRegistryError('WRONG_CLIENT', `document ${check.documentId} belongs to another browser client`)
    }
    if (record.revision !== check.revision) {
      throw new DocumentRegistryError(
        'STALE_REVISION',
        `document ${check.documentId} is revision ${String(record.revision)}, not ${String(check.revision)}`,
      )
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
    if (update.revision <= record.revision) {
      throw new DocumentRegistryError(
        'NON_MONOTONIC_REVISION',
        `document ${update.documentId} revision must increase beyond ${String(record.revision)}`,
      )
    }
    const next: AttachedDocument = { ...record, revision: update.revision }
    this.documents.set(update.documentId, next)
    return next
  }

  detachClient(clientId: ClientId): number {
    let detached = 0
    for (const [documentId, record] of this.documents) {
      if (!record.attached || record.clientId !== clientId) continue
      this.documents.set(documentId, {
        documentId,
        editorType: record.editorType,
        revision: record.revision,
        attached: false,
      })
      detached += 1
    }
    return detached
  }
}
