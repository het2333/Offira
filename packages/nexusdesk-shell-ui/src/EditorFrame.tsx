import { useRef } from 'react'
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
  const lastDocument = useRef<ShellDocumentSummary | undefined>(undefined)
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
  if (activeDocument !== undefined) lastDocument.current = activeDocument
  const document = activeDocument ?? lastDocument.current
  if (document === undefined) return null
  try {
    return (
      <iframe
        className="editor-frame"
        src={editorRoute(document)}
        title={document.title}
        aria-hidden={activeDocument === undefined}
        style={{ display: activeDocument === undefined ? 'none' : undefined }}
      />
    )
  } catch (error: unknown) {
    return (
      <div className="editor-unavailable" role="alert">
        {error instanceof Error ? error.message : 'This editor is unavailable.'}
      </div>
    )
  }
}
