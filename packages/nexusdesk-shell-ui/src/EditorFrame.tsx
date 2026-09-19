import { HostError, type ShellBootstrap, type ShellDocumentSummary } from '@nexusdesk/office-host'

export function editorRoute(document: ShellDocumentSummary): string {
  if (document.editorType === 'sheets') {
    return `/sheets/?host=local-web&documentId=${encodeURIComponent(document.documentId)}`
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
  if (bootstrap === undefined) {
    return (
      <div className="editor-loading" role="status">
        Loading editor…
      </div>
    )
  }
  if (bootstrap.capabilities.mode !== 'browser') return null
  const active = bootstrap.tabs.find((tab) => tab.active)
  if (active === undefined || active.kind === 'home') return null
  const document = bootstrap.documents.find(
    (candidate) => candidate.documentId === active.documentId,
  )
  if (document === undefined) {
    return (
      <div className="editor-unavailable" role="alert">
        This document is no longer available.
      </div>
    )
  }
  try {
    return <iframe className="editor-frame" src={editorRoute(document)} title={document.title} />
  } catch (error: unknown) {
    return (
      <div className="editor-unavailable" role="alert">
        {error instanceof Error ? error.message : 'This editor is unavailable.'}
      </div>
    )
  }
}
