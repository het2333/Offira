/** Compile-time identity that keeps unrelated wire strings distinct. */
export type Brand<T, B extends string> = T & { readonly __brand: B }

export type ClientId = Brand<string, 'ClientId'>
export type DocumentId = Brand<string, 'DocumentId'>
export type OperationId = Brand<string, 'OperationId'>
export type RequestId = Brand<string, 'RequestId'>
export type RendererInstanceId = Brand<string, 'RendererInstanceId'>
export type SessionId = Brand<string, 'SessionId'>
export type TransactionId = Brand<string, 'TransactionId'>
export type Revision = Brand<number, 'Revision'>

export interface MutationTarget {
  sessionId: SessionId
  documentId: DocumentId
  editorType: string
  revision: Revision
  operationId: OperationId
  clientId: ClientId
}
