import {
  PROTOCOL_VERSION,
  type DocumentId,
  type RendererInstanceId,
  type RequestId,
  type Revision,
  type WorkingCopyBootstrap,
} from '@nexusdesk/protocol'

import type { NexusClient } from './client'

export interface EditorRegistrationInput {
  documentId: DocumentId
  editorType: string
  revision: Revision
  workingCopy?: boolean
}

export interface EditorRegistrationHandle {
  readonly attached: boolean
  setEditorSessionId(id: string | null): void
  setHydrated(state: WorkingCopyBootstrap | null): void
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
  const rendererInstanceId = globalThis.crypto.randomUUID() as RendererInstanceId
  let revision = input.revision
  let disposed = false
  let gated = input.workingCopy === true
  let hydrated: WorkingCopyBootstrap | null = null
  let registered = false
  let registrationId: RequestId | undefined
  let editorSessionId: string | null = null

  const sendRegistration = (): void => {
    if (disposed || client.state !== 'ready' || client.clientId === undefined) return
    if (gated && (!hydrated || hydrated.recoveryState !== 'ready')) return
    registered = false
    registrationId = requestId('register')
    client.send({
      type: 'editor:register',
      protocolVersion: PROTOCOL_VERSION,
      id: registrationId,
      clientId: client.clientId,
      rendererInstanceId,
      documentId: input.documentId,
      editorType: input.editorType,
      revision,
      ...(editorSessionId !== null ? { editorSessionId } : {}),
      ...(gated && hydrated ? { documentEpoch: hydrated.documentEpoch, sourceContentId: hydrated.sourceContentId,
        restoredCheckpointId: hydrated.checkpointId } : {}),
    })
    if (!gated) registered = true
  }

  const unsubscribe = client.onState((state) => {
    registered = false
    if (state === 'ready') sendRegistration()
  })
  const unsubscribeFrame = client.onFrame((frame) => {
    if (frame.type === 'editor:registered' && frame.id === registrationId && hydrated &&
        frame.documentId === input.documentId && frame.documentEpoch === hydrated.documentEpoch &&
        frame.sourceContentId === hydrated.sourceContentId && frame.revision === hydrated.workingRevision) registered = true
    if (frame.type === 'recovery:required' && frame.documentId === input.documentId) registered = false
  })
  sendRegistration()

  return {
    get attached() { return !disposed && registered && client.state === 'ready' && (!gated || hydrated !== null) },
    setEditorSessionId(id) {
      if (disposed || editorSessionId === id) return
      editorSessionId = id
      registered = false
      sendRegistration()
    },
    setHydrated(state) {
      if (disposed) return
      gated = true
      hydrated = state === null ? null : { ...state }
      registered = false
      if (state !== null) { revision = state.workingRevision as Revision; sendRegistration() }
    },
    updateRevision(nextRevision) {
      if (disposed || gated) return
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
      unsubscribeFrame()
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
