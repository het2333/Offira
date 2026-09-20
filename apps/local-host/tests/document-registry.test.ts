import { describe, expect, it } from 'vitest'

import type { ClientId, DocumentId, Revision } from '@nexusdesk/protocol'
import { DocumentRegistry, DocumentRegistryError } from '../src/document-registry'

const documentId = 'document-1' as DocumentId
const clientId = 'client-1' as ClientId
const otherClient = 'client-2' as ClientId
const revision = 4 as Revision

function registry(): DocumentRegistry {
  return new DocumentRegistry([{ documentId, editorType: 'sheets', revision }])
}

function registryErrorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    if (!(error instanceof DocumentRegistryError)) throw error
    return error.code
  }
}

describe('DocumentRegistry', () => {
  it('accepts only the registered browser client at the current revision', () => {
    const documents = registry()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })

    expect(documents.assertOwner({ documentId, clientId, revision }).editorType).toBe('sheets')
    expect(registryErrorCode(() => documents.assertOwner({ documentId, clientId: otherClient, revision })))
      .toBe('WRONG_CLIENT')
    expect(registryErrorCode(() => documents.assertOwner({ documentId, clientId, revision: 3 as Revision })))
      .toBe('STALE_REVISION')
  })

  it('advances revisions monotonically and rejects the previous revision', () => {
    const documents = registry()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })

    documents.commitRevision({ documentId, clientId, revision: 5 as Revision })

    expect(registryErrorCode(() => documents.assertOwner({ documentId, clientId, revision })))
      .toBe('STALE_REVISION')
    expect(documents.assertOwner({ documentId, clientId, revision: 5 as Revision }).revision).toBe(5)
    expect(documents.commitRevision({
      documentId,
      clientId,
      revision: 5 as Revision,
    }).revision).toBe(5)
    expect(registryErrorCode(() => documents.commitRevision({ documentId, clientId, revision })))
      .toBe('NON_MONOTONIC_REVISION')
    expect(registryErrorCode(() => documents.commitRevision({ documentId, clientId, revision: 7 as Revision })))
      .toBe('NON_MONOTONIC_REVISION')
  })

  it('blocks writes after disconnect until explicit registration', () => {
    const documents = registry()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })

    expect(documents.detachClient(clientId)).toBe(1)
    expect(registryErrorCode(() => documents.assertOwner({ documentId, clientId, revision })))
      .toBe('DOCUMENT_DETACHED')

    documents.register({ documentId, clientId: otherClient, editorType: 'sheets', revision })
    expect(documents.assertOwner({ documentId, clientId: otherClient, revision }).clientId).toBe(otherClient)
  })

  it('rejects registration for documents and metadata not authorized by the Host', () => {
    const documents = registry()

    expect(registryErrorCode(() => documents.register({
      documentId: 'unknown' as DocumentId,
      clientId,
      editorType: 'sheets',
      revision,
    }))).toBe('DOCUMENT_NOT_FOUND')
    expect(registryErrorCode(() => documents.register({
      documentId,
      clientId,
      editorType: 'docs',
      revision,
    }))).toBe('WRONG_EDITOR')
    expect(registryErrorCode(() => documents.register({
      documentId,
      clientId,
      editorType: 'sheets',
      revision: 5 as Revision,
    }))).toBe('STALE_REVISION')
    expect(registryErrorCode(() => documents.assertClient(documentId, clientId)))
      .toBe('DOCUMENT_DETACHED')
  })

  it('keeps an attached owner across idempotent registration and rejects takeover', () => {
    const documents = registry()
    const registration = { documentId, clientId, editorType: 'sheets', revision }

    const first = documents.register(registration)

    expect(documents.register(registration)).toEqual(first)
    expect(registryErrorCode(() => documents.register({
      ...registration,
      clientId: otherClient,
    }))).toBe('WRONG_CLIENT')
    expect(documents.assertOwner({ documentId, clientId, revision })).toEqual(first)
  })

  it('does not let a late disconnect detach a newer owner', () => {
    const documents = registry()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    documents.detachClient(clientId)
    documents.register({ documentId, clientId: otherClient, editorType: 'sheets', revision })

    expect(documents.detachClient(clientId)).toBe(0)
    expect(documents.assertOwner({ documentId, clientId: otherClient, revision }).clientId)
      .toBe(otherClient)
  })

  it('detaches only the requested document while the socket remains open', () => {
    const otherDocumentId = 'document-2' as DocumentId
    const documents = new DocumentRegistry([
      { documentId, editorType: 'sheets', revision },
      { documentId: otherDocumentId, editorType: 'sheets', revision },
    ])
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    documents.register({ documentId: otherDocumentId, clientId, editorType: 'sheets', revision })

    documents.detach({ documentId, clientId })

    expect(registryErrorCode(() => documents.assertClient(documentId, clientId)))
      .toBe('DOCUMENT_DETACHED')
    expect(documents.assertClient(otherDocumentId, clientId).clientId).toBe(clientId)
  })

  it('does not let stale Host metadata reset an attached owner', () => {
    const documents = registry()
    documents.register({ documentId, clientId, editorType: 'sheets', revision })
    documents.commitRevision({ documentId, clientId, revision: 5 as Revision })

    documents.refreshFromHost({ documentId, editorType: 'sheets', revision })

    expect(documents.assertOwner({
      documentId,
      clientId,
      revision: 5 as Revision,
    }).revision).toBe(5)
  })
})
