import { Component, useEffect, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SessionBinding,
  SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PropsRenderFactories,
  PropsRenderSlots,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { requireOfficePanelBinding } from './binding.js'
import { OfficePanelCaptureFailure, startPendingSubmissionCapture } from './pending-submissions.js'

export const OFFICE_PANEL_CONTENT_SLOT = 'office.content' as const
export const OFFICE_PANEL_PRIMARY_PRIORITY = -200
export const OFFICE_PANEL_FALLBACK_PRIORITY = -100

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'office.content': {
      kind: 'single'
      scope: 'session-maybe'
    }
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    officePanel: unknown
  }
}

type OfficeRootProps = PropsRuntime<'root'> & PropsRenderSlots<'office.content'>
type OfficeContentProps = PropsRuntime<'office.content'> & PropsRenderFactories

interface OfficePanelOwnership {
  readonly reference: SessionReference
  readonly failure: OfficePanelCaptureFailure
  dispose(): void
}

interface OfficePanelErrorBoundaryProps {
  readonly children: ReactNode
}

interface OfficePanelErrorBoundaryState {
  readonly failed: boolean
}

function OfficeFailureScreen(): ReactNode {
  return (
    <div
      data-nexusdesk-office-panel="failed"
      role="alert"
      style={{
        alignItems: 'center',
        boxSizing: 'border-box',
        display: 'flex',
        justifyContent: 'center',
        minHeight: '100%',
        padding: '24px',
        textAlign: 'center',
      }}
    >
      The Office assistant is unavailable. Reopen this panel to reconnect safely.
    </div>
  )
}

class OfficePanelErrorBoundary extends Component<
  OfficePanelErrorBoundaryProps,
  OfficePanelErrorBoundaryState
> {
  state: OfficePanelErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): OfficePanelErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The carrier owns diagnostics. This boundary deliberately exposes no failed plugin data.
  }

  render(): ReactNode {
    return this.state.failed ? <OfficeFailureScreen /> : this.props.children
  }
}

function OfficePanelBody(
  props: OfficeRootProps & {
    failure: OfficePanelCaptureFailure
    reference: SessionReference
  },
): ReactNode {
  const failure = useSyncExternalStore(
    props.failure.subscribe,
    props.failure.getSnapshot,
    props.failure.getSnapshot,
  )
  if (failure !== null) throw failure

  return (
    <div
      data-nexusdesk-office-panel="ready"
      style={{ height: '100%', minHeight: 0, width: '100%' }}
    >
      <props.SessionProvider empty={OfficeFailureScreen} session={props.reference}>
        {props.renderSlot(
          OFFICE_PANEL_CONTENT_SLOT,
          {},
          {
            fallback: <OfficeFailureScreen />,
          },
        )}
      </props.SessionProvider>
    </div>
  )
}

function createOfficeRoot(ownership: OfficePanelOwnership) {
  return function OfficePanelRoot(props: OfficeRootProps): ReactNode {
    useEffect(() => () => ownership.dispose(), [])
    return (
      <OfficePanelErrorBoundary>
        <OfficePanelBody {...props} failure={ownership.failure} reference={ownership.reference} />
      </OfficePanelErrorBoundary>
    )
  }
}

function OfficeFallbackRoot(): ReactNode {
  return <OfficeFailureScreen />
}

export function OfficeConversationContent(props: OfficeContentProps): ReactNode {
  return props.renderFactorySlot(
    'conversation.content',
    {
      variant: 'embedded',
      phase: 'active',
      hero: false,
    },
    {
      fallback: <OfficeFailureScreen />,
    },
  )
}

function assertMatchingSession(
  expectedSessionId: string,
  reference: SessionReference,
  binding: SessionBinding,
): void {
  const observed = [reference.sessionId, binding.sessionId, binding.session.getSnapshot().sessionId]
  const mismatch = observed.find((sessionId) => sessionId !== expectedSessionId)
  if (mismatch !== undefined) {
    throw new Error(
      `Office panel expected Session "${expectedSessionId}" but observed "${mismatch}"`,
    )
  }
}

export const inject = ['slots', 'sessions', 'uiSession', 'uiConversation']

/** Activate the Office-only root after retaining and validating its exact Session. */
export async function apply(ctx: Context): Promise<void> {
  const carrier = requireOfficePanelBinding()
  const reference = ctx.sessions.retain(carrier.sessionId as SessionId, {
    source: 'officePanel',
  })
  let released = false
  let capture: ReturnType<typeof startPendingSubmissionCapture> | undefined

  const release = (): void => {
    if (released) return
    released = true
    capture?.dispose()
    reference.release()
  }

  try {
    const binding = await reference.ready
    assertMatchingSession(carrier.sessionId, reference, binding)
    const failure = new OfficePanelCaptureFailure()
    capture = startPendingSubmissionCapture({
      expectedSessionId: carrier.sessionId,
      session: binding.session,
      captureSubmission: (requestId) => carrier.captureSubmission(requestId),
      onError: (error) => failure.fail(error),
    })
    const ownership: OfficePanelOwnership = { reference, failure, dispose: release }

    ctx.effect(() => release, 'office-panel-ui: Session reference and submission capture')
    ctx.slots.register(
      {
        name: 'root',
        priority: OFFICE_PANEL_FALLBACK_PRIORITY,
      },
      OfficeFallbackRoot,
    )
    ctx.slots.register(
      {
        name: 'root',
        priority: OFFICE_PANEL_PRIMARY_PRIORITY,
        children: {
          [OFFICE_PANEL_CONTENT_SLOT]: { kind: 'single', scope: 'session-maybe' },
        },
      },
      createOfficeRoot(ownership),
    )
    ctx.slots.register({ name: OFFICE_PANEL_CONTENT_SLOT }, OfficeConversationContent)
  } catch (error) {
    release()
    throw error
  }
}
