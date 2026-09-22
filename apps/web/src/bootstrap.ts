import { shellBootstrapSchema } from '@nexusdesk/office-host'
import type { EditorKind } from '@nexusdesk/office-host'

export interface WebDocumentSummary {
  documentId: string
  title: string
  editorType: EditorKind
  revision: number
}

export type WebBootstrapState =
  | { kind: 'ready'; documents: WebDocumentSummary[] }
  | { kind: 'unauthenticated'; message: string; reconnectHref: string }

type FetchBootstrap = (input: string, init?: RequestInit) => Promise<Response>

export async function loadBootstrap(
  fetchBootstrap: FetchBootstrap = globalThis.fetch,
): Promise<WebBootstrapState> {
  const response = await fetchBootstrap('/api/shell/bootstrap', { credentials: 'same-origin' })
  if (response.status === 401) {
    return {
      kind: 'unauthenticated',
      message: 'Your local Offira session has expired.',
      reconnectHref: '/bootstrap/reconnect',
    }
  }
  if (!response.ok)
    throw new Error(`Local Host bootstrap failed with HTTP ${String(response.status)}`)
  const value = shellBootstrapSchema.parse(await response.json())
  return {
    kind: 'ready',
    documents: value.documents as WebDocumentSummary[],
  }
}

export function documentRoute<T extends Pick<WebDocumentSummary, 'documentId' | 'editorType'>>(
  document: T,
): string {
  return `/${document.editorType}/?host=local-web&documentId=${encodeURIComponent(document.documentId)}`
}
