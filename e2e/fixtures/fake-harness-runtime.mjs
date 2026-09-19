let turn
let pending
let savedOnce = false

const finish = () => {
  send({
    type: 'agent:event',
    sessionId: turn.sessionId,
    event: { type: 'stream/chunk', data: { type: 'text-delta', index: 0, text: '\nWorkbook saved.' } },
  })
  send({
    type: 'agent:event',
    sessionId: turn.sessionId,
    event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  })
}

const send = (frame) => process.send?.({ protocolVersion: 1, ...frame })

send({ type: 'ready', pid: process.pid, startedBundles: ['fake-sheets'] })

process.on('message', (frame) => {
  if (frame.type === 'agent:start') {
    turn = frame
    send({
      type: 'agent:event',
      sessionId: frame.sessionId,
      event: {
        type: 'stream/chunk',
        data: { type: 'text-delta', index: 0, text: 'Preparing the formula and chart.' },
      },
    })
    send({
      type: 'approval:request',
      id: 'approval-1',
      sessionId: frame.sessionId,
      toolName: 'apply_sheet_operations',
      reason: JSON.stringify({
        operations: [
          'Set Summary!A4 to Total',
          'Set Summary!B4 to =SUM(B2:B3)',
          'Add a Revenue by quarter chart',
        ],
      }),
    })
  } else if (frame.type === 'approval:response' && frame.outcome === 'allowed-once') {
    pending = 'apply'
    send({
      type: 'editor:request',
      id: 'editor-request-1',
      target: {
        sessionId: turn.sessionId,
        documentId: turn.documentId,
        editorType: 'sheets',
        revision: turn.revision,
        operationId: 'operation-1',
        clientId: turn.clientId,
      },
      command: 'apply_ops',
      arguments: {
        ops: [
          { op: 'set_cell', sheet: 'Summary', address: 'A4', value: 'Total' },
          { op: 'set_formula', sheet: 'Summary', address: 'B4', formula: '=SUM(B2:B3)' },
          {
            op: 'add_chart',
            sheet: 'Summary',
            chartType: 'column',
            dataRange: 'A1:B3',
            title: 'Revenue by quarter',
            anchorCell: 'D2',
          },
        ],
      },
    })
  } else if (frame.type === 'editor:result') {
    if (pending === 'apply') {
      if (!frame.result?.ok) {
        send({
          type: 'agent:event',
          sessionId: turn.sessionId,
          event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: frame.result?.summary } } } },
        })
        return
      }
      if (savedOnce) {
        finish()
        return
      }
      pending = 'save'
      send({
        type: 'editor:request',
        id: 'editor-request-save-1',
        target: {
          sessionId: turn.sessionId,
          documentId: turn.documentId,
          editorType: 'sheets',
          revision: turn.revision + 1,
          operationId: 'operation-save-1',
          clientId: turn.clientId,
        },
        command: 'save_sheet',
        arguments: {},
      })
      return
    }
    savedOnce = true
    finish()
  } else if (frame.type === 'shutdown') {
    send({ type: 'shutdown-complete' })
    process.disconnect?.()
  }
})
