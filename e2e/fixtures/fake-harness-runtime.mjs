let turn
let pending
let savedOnce = false
let lastRevision = 1
let pendingPlanHash

const operations = [
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
]

const finish = () => {
  send({
    type: 'agent:event',
    sessionId: turn.sessionId,
    event: {
      type: 'stream/chunk',
      data: { type: 'text-delta', index: 0, text: '\nWorkbook saved.' },
    },
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
    lastRevision = frame.revision
    pending = 'propose'
    send({
      type: 'editor:request',
      id: 'editor-propose-1',
      target: {
        sessionId: turn.sessionId,
        documentId: turn.documentId,
        editorType: 'sheets',
        revision: lastRevision,
        operationId: 'operation-1',
        clientId: turn.clientId,
      },
      command: 'propose_ops',
      arguments: { ops: operations },
    })
  } else if (frame.type === 'approval:response' && frame.outcome === 'allowed-once') {
    if (pending === 'approve-save') {
      pending = 'save'
      send({
        type: 'editor:request',
        id: 'editor-request-save-1',
        target: {
          sessionId: turn.sessionId,
          documentId: turn.documentId,
          editorType: 'sheets',
          revision: lastRevision,
          operationId: 'operation-save-1',
          clientId: turn.clientId,
        },
        command: 'save_sheet',
        arguments: {},
        approval: { id: 'approval-save-1', planHash: 'save-current-workbook-in-place' },
      })
      return
    }
    pending = 'apply'
    send({
      type: 'editor:request',
      id: 'editor-request-1',
      target: {
        sessionId: turn.sessionId,
        documentId: turn.documentId,
        editorType: 'sheets',
        revision: lastRevision,
        operationId: 'operation-1',
        clientId: turn.clientId,
      },
      command: 'apply_ops',
      arguments: { ops: operations },
      approval: { id: 'approval-1', planHash: pendingPlanHash },
    })
  } else if (frame.type === 'editor:result') {
    lastRevision = frame.currentRevision ?? lastRevision
    if (pending === 'propose') {
      pendingPlanHash = frame.result?.data?.planHash
      pending = 'approve-apply'
      send({
        type: 'approval:request',
        id: 'approval-1',
        sessionId: turn.sessionId,
        toolName: 'apply_sheet_operations',
        reason: frame.result?.summary,
        proposal: {
          planHash: pendingPlanHash,
          summary: frame.result?.data?.summary,
          targets: frame.result?.data?.targets ?? [],
          warnings: frame.result?.warnings ?? [],
        },
      })
      return
    }
    if (pending === 'apply') {
      if (!frame.result?.ok) {
        send({
          type: 'agent:event',
          sessionId: turn.sessionId,
          event: {
            type: 'turn/end',
            data: { reason: { kind: 'error', error: { message: frame.result?.summary } } },
          },
        })
        return
      }
      if (savedOnce) {
        finish()
        return
      }
      pending = 'approve-save'
      send({
        type: 'approval:request',
        id: 'approval-save-1',
        sessionId: turn.sessionId,
        toolName: 'save_sheet',
        reason: 'Save the current spreadsheet in place.',
        proposal: {
          planHash: 'save-current-workbook-in-place',
          summary: 'Save the current spreadsheet in place.',
          targets: ['current workbook'],
          warnings: [],
        },
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
