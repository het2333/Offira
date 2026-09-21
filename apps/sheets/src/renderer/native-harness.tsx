import { useEffect, useRef, useState } from 'react'
import {
  mountHarnessPanel,
  type HarnessPanelSnapshot,
} from '@nexusdesk/web-client'

export function nativeHarnessEnabled(search: string): boolean {
  return new URLSearchParams(search).get('nativeHarness') === '1'
}

interface NativeHarnessPanelProps {
  readonly isOpen: boolean
  readonly onExpand: () => void
  readonly onCollapse: () => void
  readonly captureSnapshot: () => HarnessPanelSnapshot
}

const UNAVAILABLE_MESSAGE =
  '文档助手尚未连接到当前文档。请使用本地 Web 模式重新打开此面板。'

/** Sheets-only wrapper around the official Harness frontend. */
export function NativeHarnessPanel({
  isOpen,
  onExpand,
  onCollapse,
  captureSnapshot,
}: NativeHarnessPanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const captureRef = useRef(captureSnapshot)
  captureRef.current = captureSnapshot
  const [failure, setFailure] = useState<string | null>(null)
  const [connectionEpoch, setConnectionEpoch] = useState(0)

  useEffect(() => {
    const client = window.nexusdeskBrowserHost?.bridge.transportClient()
    return client?.onState(() => setConnectionEpoch((value) => value + 1))
  }, [])

  useEffect(() => {
    if (!isOpen || containerRef.current === null) return
    const host = window.nexusdeskBrowserHost
    const clientId = host?.bridge.client().clientId
    if (host === undefined || clientId === undefined) {
      setFailure(UNAVAILABLE_MESSAGE)
      return
    }

    setFailure(null)
    const abort = new AbortController()
    const mounted = mountHarnessPanel({
      container: containerRef.current,
      client: host.bridge.transportClient(),
      clientId,
      documentId: host.document.documentId,
      captureSnapshot: () => captureRef.current(),
      signal: abort.signal,
    })
    void mounted.catch((error: unknown) => {
      if (abort.signal.aborted) return
      setFailure(error instanceof Error ? error.message : UNAVAILABLE_MESSAGE)
    })
    return () => abort.abort()
  }, [isOpen, connectionEpoch])

  if (!isOpen) {
    return (
      <aside className="copilot collapsed">
        <button
          className="expand-copilot"
          onClick={onExpand}
          title="打开文档助手"
          aria-label="打开文档助手"
        >
          AI
        </button>
      </aside>
    )
  }

  return (
    <aside className="copilot native-harness-panel">
      <button
        className="ai-header-btn native-harness-collapse"
        onClick={onCollapse}
        title="收起文档助手"
        aria-label="收起文档助手"
      >
        ‹
      </button>
      {failure === null ? (
        <div className="native-harness-panel-host" ref={containerRef} />
      ) : (
        <div className="native-harness-panel-error" role="alert">
          {failure}
        </div>
      )}
    </aside>
  )
}
