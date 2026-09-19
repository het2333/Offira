import {
  PROTOCOL_VERSION,
  type DocumentId,
  type RequestId,
  type Revision,
} from '@nexusdesk/protocol'

import type { NexusClient } from './client'

export interface EditorRegistrationInput {
  documentId: DocumentId
  editorType: string
  revision: Revision
}

export interface EditorRegistrationHandle {
  updateRevision(revision: Revision): void
  dispose(): void
}

function requestId(prefix: string): RequestId {
  return `${prefix}-${globalThis.crypto.randomUUID()}` as RequestId
}

export function registerEditor(
  client: NexusClient,
  input: EditorRegistrationInput,
): EditorRegistrationHandle {
  let revision = input.revision
  let disposed = false

  const sendRegistration = (): void => {
    if (disposed || client.state !== 'ready' || client.clientId === undefined) return
    client.send({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: requestId('register'),
      clientId: client.clientId,
      documentId: input.documentId,
      editorType: input.editorType,
      revision,
    })
  }

  const unsubscribe = client.onState((state) => {
    if (state === 'ready') sendRegistration()
  })
  sendRegistration()

  return {
    updateRevision(nextRevision) {
      if (disposed) return
      revision = nextRevision
      if (client.state !== 'ready' || client.clientId === undefined) return
      client.send({
        type: 'editor:revision',
        protocolVersion: PROTOCOL_VERSION,
        id: requestId('revision'),
        clientId: client.clientId,
        documentId: input.documentId,
        revision,
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      if (client.state === 'ready' && client.clientId !== undefined) {
        client.send({
          type: 'editor:detach',
          protocolVersion: PROTOCOL_VERSION,
          id: requestId('detach'),
          clientId: client.clientId,
          documentId: input.documentId,
        })
      }
    },
  }
}
