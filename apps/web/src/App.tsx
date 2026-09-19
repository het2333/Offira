import { useEffect, useState } from 'react'

import { documentRoute, loadBootstrap, type WebBootstrapState } from './bootstrap'

type AppState = WebBootstrapState | { kind: 'loading' } | { kind: 'error'; message: string }

function currentDocumentId(): string | undefined {
  const match = window.location.pathname.match(/^\/edit\/sheets\/([^/]+)$/)
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1])
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>({ kind: 'loading' })
  useEffect(() => {
    void loadBootstrap()
      .then(setState)
      .catch((error: unknown) => setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'NexusDesk could not connect to Local Host.',
      }))
  }, [])

  if (state.kind === 'loading') return <main className="center-state">Connecting to Local Host…</main>
  if (state.kind === 'unauthenticated') {
    return <main className="center-state" role="alert">
      <h1>Reconnect NexusDesk</h1>
      <p>{state.message}</p>
      <a className="primary-action" href={state.reconnectHref}>Reconnect</a>
    </main>
  }
  if (state.kind === 'error') {
    return <main className="center-state" role="alert">
      <h1>NexusDesk could not start</h1>
      <p>{state.message}</p>
    </main>
  }

  const activeId = currentDocumentId()
  const active = state.documents.find((document) => document.documentId === activeId)
  return <main className="shell">
    <header>
      <strong>NexusDesk</strong>
      <span className="connection-status">Local Host connected</span>
    </header>
    <nav aria-label="Open documents">
      {state.documents.map((document) => <a
        aria-current={document.documentId === activeId ? 'page' : undefined}
        href={documentRoute(document)}
        key={document.documentId}
      >{document.title}</a>)}
    </nav>
    {active === undefined
      ? <section className="document-list">
          <h1>Open documents</h1>
          {state.documents.length === 0
            ? <p>No documents are registered with this Local Host.</p>
            : state.documents.map((document) => <a href={documentRoute(document)} key={document.documentId}>
                {document.title}
              </a>)}
        </section>
      : <iframe
          className="editor-frame"
          src={`/sheets/?host=local-web&documentId=${encodeURIComponent(active.documentId)}`}
          title={active.title}
        />}
  </main>
}
