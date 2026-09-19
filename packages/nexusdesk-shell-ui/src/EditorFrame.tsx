import { useRef } from 'react'
import { HostError, type ShellBootstrap, type ShellDocumentSummary } from '@nexusdesk/office-host'

export function editorRoute(document: ShellDocumentSummary): string {
  if (
    document.editorType === 'docs' ||
    document.editorType === 'sheets' ||
    document.editorType === 'markdown' ||
    document.editorType === 'html'
  ) {
    return `/${document.editorType}/?host=local-web&documentId=${encodeURIComponent(document.documentId)}`
  }
  throw new HostError(
    'EDITOR_NOT_AVAILABLE',
    `${document.editorType} is not available in this build`,
    false,
    document.documentId,
  )
}

export function EditorFrame({
  bootstrap,
}: {
  bootstrap: ShellBootstrap | undefined
}): React.JSX.Element | null {
  const mountedDocuments = useRef(new Map<string, ShellDocumentSummary>())
  if (bootstrap === undefined) {
    return (
      <div className="editor-loading" role="status">
        Loading editor…
      </div>
    )
  }
  if (bootstrap.capabilities.mode !== 'browser') return null
  const active = bootstrap.tabs.find((tab) => tab.active)
  const hasActiveDocumentTab = active !== undefined && active.kind !== 'home'
  const activeDocument = !hasActiveDocumentTab
    ? undefined
    : bootstrap.documents.find((candidate) => candidate.documentId === active.documentId)
  if (hasActiveDocumentTab && activeDocument === undefined) {
    return (
      <div className="editor-unavailable" role="alert">
        This document is no longer available.
      </div>
    )
  }
  for (const tab of bootstrap.tabs) {
    if (tab.kind === 'home') continue
    const document = bootstrap.documents.find(
      (candidate) => candidate.documentId === tab.documentId,
    )
    if (document !== undefined) mountedDocuments.current.set(document.documentId, document)
  }
  if (mountedDocuments.current.size === 0) return null
  return (
    <>
      {[...mountedDocuments.current.values()].map((document) => {
        const visible = activeDocument?.documentId === document.documentId
        try {
          return (
            <iframe
              key={document.documentId}
              className="editor-frame"
              src={editorRoute(document)}
              title={document.title}
              aria-hidden={!visible}
              style={{ display: visible ? undefined : 'none' }}
            />
          )
        } catch (error: unknown) {
          return visible ? (
            <div key={document.documentId} className="editor-unavailable" role="alert">
              {error instanceof Error ? error.message : 'This editor is unavailable.'}
            </div>
          ) : null
        }
      })}
    </>
  )
}
