let activeSession
let activeTurn

process.send?.({
  type: 'ready',
  protocolVersion: 1,
  pid: process.pid,
  startedBundles: ['fake'],
  toolCatalogs: {
    docs: ['read_document', 'apply_document_operations', 'save_document'],
    sheets: ['read_sheet', 'apply_sheet_operations', 'save_sheet'],
  },
})

if (process.argv[2] === 'idle-crash') {
  setTimeout(() => process.exit(19), 30)
}

process.on('message', (frame) => {
  if (frame.type === 'agent:start') {
    activeSession = frame.sessionId
    activeTurn = frame
    process.send?.({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: frame.sessionId,
      event: { type: 'test/start-received', data: { prompt: frame.prompt } },
    })
    if (frame.prompt === 'approval-crash') {
      process.send?.(
        {
          type: 'approval:request',
          protocolVersion: 1,
          id: 'approval-1',
          sessionId: frame.sessionId,
          toolName: 'apply_sheet_operations',
          reason: 'change B2',
        },
        () => process.exit(17),
      )
      return
    }
    if (frame.prompt === 'approval-wait') {
      process.send?.({
        type: 'approval:request',
        protocolVersion: 1,
        id: 'approval-1',
        sessionId: frame.sessionId,
        toolName: 'apply_sheet_operations',
        reason: 'change B2',
      })
      return
    }
    if (frame.prompt === 'editor-wait') {
      process.send?.({
        type: 'approval:request',
        protocolVersion: 1,
        id: 'editor-approval-1',
        sessionId: frame.sessionId,
        toolName: 'apply_sheet_operations',
        proposal: {
          operationId: 'operation-1',
          planHash: 'exact-plan-hash',
          summary: 'Update Summary!B2.',
          targets: ['Summary!B2'],
          warnings: [],
        },
      })
      return
    }
    if (frame.prompt === 'docs-save-unapproved' || frame.prompt === 'slides-save-unapproved' || frame.prompt === 'slides-history-unapproved') {
      process.send?.({
        type: 'editor:request',
        protocolVersion: 1,
        id: 'docs-save-request-1',
        target: {
          sessionId: activeTurn.sessionId,
          documentId: activeTurn.documentId,
          editorType: activeTurn.editorType,
          revision: activeTurn.revision,
          operationId: `${activeTurn.editorType}-save-operation-1`,
          clientId: activeTurn.clientId,
        },
        command: frame.prompt === 'slides-history-unapproved' ? 'apply_history' : activeTurn.editorType === 'slides' ? 'save_presentation' : 'save_document',
        arguments: frame.prompt === 'slides-history-unapproved' ? { action: 'undo' } : { inPlace: true },
      })
      return
    }
    if (frame.prompt === 'markdown-save-unapproved') {
      process.send?.({
        type: 'editor:request',
        protocolVersion: 1,
        id: 'markdown-save-request-1',
        target: {
          sessionId: activeTurn.sessionId,
          documentId: activeTurn.documentId,
          editorType: activeTurn.editorType,
          revision: activeTurn.revision,
          operationId: 'markdown-save-operation-1',
          clientId: activeTurn.clientId,
        },
        command: 'save_markdown',
        arguments: { inPlace: true },
      })
      return
    }
    if (frame.prompt === 'html-save-wrong-approval' || frame.prompt === 'html-save-replayed-approval') {
      process.send?.({
        type: 'approval:request',
        protocolVersion: 1,
        id: 'content-save-approval-1',
        sessionId: frame.sessionId,
        toolName: 'save_html',
        proposal: {
          planHash: 'content-save-plan-hash',
          summary: 'Save the HTML document.',
          targets: ['Page.html'],
          warnings: [],
        },
      })
      return
    }
    if (frame.prompt === 'slides-save-wrong-plan' || frame.prompt === 'slides-save-reuse-approval') {
      process.send?.({
        type: 'approval:request',
        protocolVersion: 1,
        id: 'slides-save-approval-1',
        sessionId: frame.sessionId,
        toolName: 'save_presentation',
        proposal: {
          planHash: 'slides-save-plan-hash',
          summary: 'Save the presentation.',
          targets: ['presentation'],
          warnings: [],
        },
      })
      return
    }
    if (frame.prompt === 'slides-save-proposal') {
      process.send?.({
        type: 'editor:request',
        protocolVersion: 1,
        id: 'slides-save-proposal-request-1',
        target: {
          sessionId: activeTurn.sessionId,
          documentId: activeTurn.documentId,
          editorType: 'slides',
          revision: activeTurn.revision,
          operationId: 'slides-save-proposal-operation-1',
          clientId: activeTurn.clientId,
        },
        command: 'propose_save',
        arguments: {},
      })
      return
    }
    if (frame.prompt === 'crash') {
      process.exit(18)
      return
    }
    process.send?.({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: frame.sessionId,
      event: { type: 'stream/chunk', data: { type: 'text-delta', index: 0, text: 'done' } },
    })
    process.send?.({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: frame.sessionId,
      event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    })
  } else if (frame.type === 'agent:cancel') {
    process.send?.({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: frame.sessionId ?? activeSession,
      event: { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    })
  } else if (frame.type === 'approval:response') {
    if (frame.id === 'content-save-approval-1' && frame.outcome === 'allowed-once') {
      const wrongApproval = activeTurn.prompt === 'html-save-wrong-approval'
      const request = {
        type: 'editor:request',
        protocolVersion: 1,
        id: 'html-save-request-1',
        target: {
          sessionId: activeTurn.sessionId,
          documentId: activeTurn.documentId,
          editorType: 'html',
          revision: activeTurn.revision,
          operationId: 'html-save-operation-1',
          clientId: activeTurn.clientId,
        },
        command: 'save_html',
        arguments: { inPlace: true },
        approval: {
          id: 'content-save-approval-1',
          planHash: wrongApproval ? 'wrong-plan-hash' : 'content-save-plan-hash',
        },
      }
      process.send?.(request)
      if (activeTurn.prompt === 'html-save-replayed-approval') {
        process.send?.({ ...request, id: 'html-save-request-2' })
      }
      return
    }
    if (frame.id === 'slides-save-approval-1' && frame.outcome === 'allowed-once') {
      const request = (id, operationId, planHash) => ({
        type: 'editor:request',
        protocolVersion: 1,
        id,
        target: {
          sessionId: activeTurn.sessionId,
          documentId: activeTurn.documentId,
          editorType: 'slides',
          revision: activeTurn.revision,
          operationId,
          clientId: activeTurn.clientId,
        },
        command: 'save_presentation',
        arguments: { inPlace: true },
        approval: { id: 'slides-save-approval-1', planHash },
      })
      if (activeTurn.prompt === 'slides-save-wrong-plan') {
        process.send?.(
          request(
            'slides-save-wrong-request-1',
            'slides-save-wrong-operation-1',
            'wrong-plan-hash',
          ),
        )
      } else {
        process.send?.(
          request(
            'slides-save-reuse-request-1',
            'slides-save-reuse-operation-1',
            'slides-save-plan-hash',
          ),
        )
        process.send?.(
          request(
            'slides-save-reuse-request-2',
            'slides-save-reuse-operation-2',
            'slides-save-plan-hash',
          ),
        )
      }
      return
    }
    if (frame.id === 'slides-save-proposal-approval-1' && frame.outcome === 'allowed-once') {
      process.send?.({
        type: 'editor:request',
        protocolVersion: 1,
        id: 'slides-save-request-1',
        target: {
          sessionId: activeTurn.sessionId,
          documentId: activeTurn.documentId,
          editorType: 'slides',
          revision: activeTurn.revision,
          operationId: 'slides-save-proposal-operation-1',
          clientId: activeTurn.clientId,
        },
        command: 'save_presentation',
        arguments: { inPlace: true, contentVersion: 2 },
        approval: {
          id: 'slides-save-proposal-approval-1',
          planHash: 'slides-save-proposal-plan-hash',
        },
      })
      return
    }
    if (frame.id === 'editor-approval-1' && frame.outcome === 'allowed-once') {
      process.send?.({
        type: 'editor:request',
        protocolVersion: 1,
        id: 'editor-request-1',
        target: {
          sessionId: activeTurn.sessionId,
          documentId: activeTurn.documentId,
          editorType: 'sheets',
          revision: activeTurn.revision,
          operationId: 'operation-1',
          clientId: activeTurn.clientId,
        },
        command: 'apply_ops',
        arguments: { ops: [{ op: 'set_cell', sheet: 'Summary', address: 'B2', value: 5 }] },
        approval: { id: 'editor-approval-1', planHash: 'exact-plan-hash' },
      })
      return
    }
    process.send?.({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: activeSession,
      event: { type: 'test/approval-response', data: { id: frame.id, outcome: frame.outcome } },
    })
  } else if (frame.type === 'editor:result') {
    if (
      activeTurn?.prompt === 'slides-save-proposal' &&
      frame.id === 'slides-save-proposal-request-1'
    ) {
      process.send?.({
        type: 'approval:request',
        protocolVersion: 1,
        id: 'slides-save-proposal-approval-1',
        sessionId: activeSession,
        toolName: 'save_presentation',
        proposal: {
          planHash: frame.result?.data?.planHash,
          summary: 'Save the presentation.',
          targets: ['presentation'],
          warnings: [],
        },
      })
      return
    }
    process.send?.({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: activeSession,
      event: {
        type: 'test/editor-result',
        data: { result: frame.result, currentRevision: frame.currentRevision },
      },
    })
  } else if (frame.type === 'shutdown') {
    process.send?.({ type: 'shutdown-complete', protocolVersion: 1 }, () => process.disconnect())
  }
})
