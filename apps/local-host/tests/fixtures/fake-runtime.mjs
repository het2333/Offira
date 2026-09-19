let activeSession

process.send?.({ type: 'ready', protocolVersion: 1, pid: process.pid, startedBundles: ['fake'] })

if (process.argv[2] === 'idle-crash') {
  setTimeout(() => process.exit(19), 30)
}

process.on('message', (frame) => {
  if (frame.type === 'agent:start') {
    activeSession = frame.sessionId
    process.send?.({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: frame.sessionId,
      event: { type: 'test/start-received', data: { prompt: frame.prompt } },
    })
    if (frame.prompt === 'approval-crash') {
      process.send?.({
        type: 'approval:request',
        protocolVersion: 1,
        id: 'approval-1',
        sessionId: frame.sessionId,
        toolName: 'apply_sheet_operations',
        reason: 'change B2',
      }, () => process.exit(17))
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
        type: 'editor:request',
        protocolVersion: 1,
        id: 'editor-request-1',
        target: {
          sessionId: frame.sessionId,
          documentId: frame.documentId,
          editorType: 'sheets',
          revision: frame.revision,
          operationId: 'operation-1',
          clientId: frame.clientId,
        },
        command: 'apply_ops',
        arguments: { ops: [{ op: 'set_cell', sheet: 'Summary', address: 'B2', value: 5 }] },
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
    process.send?.({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: activeSession,
      event: { type: 'test/approval-response', data: { id: frame.id, outcome: frame.outcome } },
    })
  } else if (frame.type === 'editor:result') {
    process.send?.({
      type: 'agent:event',
      protocolVersion: 1,
      sessionId: activeSession,
      event: { type: 'test/editor-result', data: frame.result },
    })
  } else if (frame.type === 'shutdown') {
    process.send?.({ type: 'shutdown-complete', protocolVersion: 1 }, () => process.disconnect())
  }
})
