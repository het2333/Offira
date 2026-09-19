import { describe, expect, it } from 'vitest'

import type { ClientId, DocumentId, Revision } from '@nexusdesk/protocol'
import { DocumentRegistry, DocumentRegistryError } from '../src/document-registry'

const documentId = 'document-1' as DocumentId
const clientId = 'client-1' as ClientId
const otherClient = 'client-2' as ClientId
const revision = 4 as Revision

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
    const registry = new DocumentRegistry()
    registry.register({ documentId, clientId, editorType: 'sheets', revision })

    expect(registry.assertOwner({ documentId, clientId, revision }).editorType).toBe('sheets')
    expect(registryErrorCode(() => registry.assertOwner({ documentId, clientId: otherClient, revision })))
      .toBe('WRONG_CLIENT')
    expect(registryErrorCode(() => registry.assertOwner({ documentId, clientId, revision: 3 as Revision })))
      .toBe('STALE_REVISION')
  })

  it('advances revisions monotonically and rejects the previous revision', () => {
    const registry = new DocumentRegistry()
    registry.register({ documentId, clientId, editorType: 'sheets', revision })

    registry.commitRevision({ documentId, clientId, revision: 5 as Revision })

    expect(registryErrorCode(() => registry.assertOwner({ documentId, clientId, revision })))
      .toBe('STALE_REVISION')
    expect(registry.assertOwner({ documentId, clientId, revision: 5 as Revision }).revision).toBe(5)
    expect(registryErrorCode(() => registry.commitRevision({ documentId, clientId, revision: 5 as Revision })))
      .toBe('NON_MONOTONIC_REVISION')
  })

  it('blocks writes after disconnect until explicit registration', () => {
    const registry = new DocumentRegistry()
    registry.register({ documentId, clientId, editorType: 'sheets', revision })

    expect(registry.detachClient(clientId)).toBe(1)
    expect(registryErrorCode(() => registry.assertOwner({ documentId, clientId, revision })))
      .toBe('DOCUMENT_DETACHED')

    registry.register({ documentId, clientId: otherClient, editorType: 'sheets', revision })
    expect(registry.assertOwner({ documentId, clientId: otherClient, revision }).clientId).toBe(otherClient)
  })
})
