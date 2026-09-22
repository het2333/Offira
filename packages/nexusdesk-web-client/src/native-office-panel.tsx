import { useEffect, useRef, useState } from 'react'
import { mountInlineOfficePanel } from './harness-inline-panel'
import type { HarnessPanelSnapshot } from './harness-panel'
import type { NexusClient } from './client'
import type { ClientId, DocumentId } from '@nexusdesk/protocol'

export interface NativeOfficePanelHost {
  document: { documentId: string }
  bridge: { transportClient(): NexusClient; client(): { clientId: ClientId | undefined; attached: boolean } }
}

interface NativeHarnessPanelProps {
  readonly host: NativeOfficePanelHost | undefined
  readonly isOpen: boolean
  readonly onExpand: () => void
  readonly onCollapse: () => void
  readonly captureSnapshot: () => HarnessPanelSnapshot
  readonly scopeLabel?: string | null
  readonly onScopeDismiss?: () => void
  readonly draftRequest?: { id: number; text: string } | null
}

const UNAVAILABLE_MESSAGE =
  '文档助手尚未连接到当前文档。请使用本地 Web 模式重新打开此面板。'

/** Shared editor wrapper around the official Harness frontend. */
export function NativeOfficePanel({
  host: suppliedHost,
  isOpen,
  onExpand,
  onCollapse,
  captureSnapshot,
  scopeLabel,
  onScopeDismiss,
  draftRequest,
}: NativeHarnessPanelProps): React.JSX.Element {
  const hostRef = useRef(suppliedHost)
  hostRef.current = suppliedHost
  const containerRef = useRef<HTMLDivElement>(null)
  const captureRef = useRef(captureSnapshot)
  const mountStarted = useRef(false)
  const draftMailbox = useRef<{ pending?: string; listener?: (text: string) => void }>({})
  useEffect(() => {
    if (!draftRequest) return
    if (draftMailbox.current.listener) draftMailbox.current.listener(draftRequest.text)
    else draftMailbox.current.pending = draftRequest.text
  }, [draftRequest])
  captureRef.current = captureSnapshot
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [connectionEpoch, setConnectionEpoch] = useState(0)
  const [disconnected, setDisconnected] = useState(false)
  const [activated, setActivated] = useState(isOpen)
  useEffect(() => { if (isOpen) setActivated(true) }, [isOpen])

  useEffect(() => {
    const host = hostRef.current
    const client = host?.bridge.transportClient()
    if (!client) return
    let registered = host?.bridge.client().attached === true
    const offState = client.onState(() => {
      if (client.state !== 'ready') registered = false
      setDisconnected(client.state !== 'ready')
      if (!mountStarted.current) setConnectionEpoch((value) => value + 1)
    })
    const offFrame = client.onFrame((frame) => {
      if ((frame.type === 'editor:registered' || frame.type === 'editor:attached' || frame.type === 'recovery:required') &&
          frame.documentId === host?.document.documentId) {
        const nextRegistered = host?.bridge.client().attached === true
        if (nextRegistered === registered) return
        registered = nextRegistered
        if (!mountStarted.current) setConnectionEpoch((value) => value + 1)
      }
    })
    return () => { offState(); offFrame() }
  }, [])

  useEffect(() => {
    if (!activated || containerRef.current === null) return
    const host = hostRef.current
    const clientId = host?.bridge.client().clientId
    if (host === undefined) {
      setLoading(false)
      setFailure(UNAVAILABLE_MESSAGE)
      return
    }
    if (clientId === undefined || !host.bridge.client().attached || host.bridge.transportClient().state !== 'ready') {
      setLoading(true)
      return
    }

    setFailure(null)
    setLoading(true)
    mountStarted.current = true
    const abort = new AbortController()
    const mounted = mountInlineOfficePanel({
      container: containerRef.current,
      client: host.bridge.transportClient(),
      clientId,
      documentId: host.document.documentId as DocumentId,
      captureSnapshot: () => captureRef.current(),
      subscribeDraftRequests(listener) {
        draftMailbox.current.listener = listener
        if (draftMailbox.current.pending) {
          listener(draftMailbox.current.pending)
          delete draftMailbox.current.pending
        }
        return () => { delete draftMailbox.current.listener }
      },
      signal: abort.signal,
    })
    void mounted.then(() => {
      if (!abort.signal.aborted) setLoading(false)
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return
      mountStarted.current = false
      setLoading(false)
      setFailure(error instanceof Error ? error.message : UNAVAILABLE_MESSAGE)
    })
    return () => { mountStarted.current = false; abort.abort() }
  }, [activated, connectionEpoch])

  return (
    <>
      {!isOpen && <aside className="copilot collapsed">
        <button
          className="expand-copilot"
          onClick={onExpand}
          title="打开文档助手"
          aria-label="打开文档助手"
        >
          AI
        </button>
      </aside>}
    <aside className="copilot native-harness-panel" style={{ display: isOpen ? 'flex' : 'none', flexDirection: 'column', height: '100%', width: '100%', minHeight: 0, position: 'relative' }}>
      {disconnected && <div role="status">连接已中断，正在恢复。聊天和草稿已保留，不会自动重发操作。</div>}
      {scopeLabel && <div className="native-harness-scope" role="status">
        <span>{scopeLabel}</span>
        <button type="button" aria-label="取消选区引用" title="取消选区引用" onClick={onScopeDismiss}>×</button>
      </div>}
      <button
        className="ai-header-btn native-harness-collapse"
        onClick={onCollapse}
        title="收起文档助手"
        aria-label="收起文档助手"
      >
        ‹
      </button>
      <div className="native-harness-panel-host" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} ref={containerRef} hidden={failure !== null} />
      {loading && failure === null && !disconnected && <div className="native-harness-panel-loading" role="status">
        正在连接当前文档…如果长时间没有响应，请重新打开当前文档面板。
      </div>}
      {failure !== null && (
        <div className="native-harness-panel-error" role="alert">
          {failure}
          <button type="button" onClick={() => {
            setFailure(null)
            setLoading(true)
            setConnectionEpoch((value) => value + 1)
          }}>重试连接</button>
        </div>
      )}
    </aside>
    </>
  )
}
