import { writeFileSync } from 'node:fs'

let turn
let pending
let pendingPlanHash
let savedOnce = false
let lastRevision = 1
const applyCountPath = process.argv[2]
const appliedTransactions = new Set()

const operations = [{ op: 'findReplace', find: '第一段。', replace: 'Agent edit. 第一段。' }]

const send = (frame) => process.send?.({ protocolVersion: 1, ...frame })

const recordApply = (result) => {
  if (typeof result?.transactionId === 'string') appliedTransactions.add(result.transactionId)
  if (applyCountPath) {
    writeFileSync(applyCountPath, JSON.stringify({ applyCount: appliedTransactions.size }))
  }
}

const target = (operationId) => ({
  sessionId: turn.sessionId,
  documentId: turn.documentId,
  editorType: 'docs',
  revision: lastRevision,
  operationId,
  clientId: turn.clientId,
})

const finish = () => {
  send({
    type: 'agent:event',
    sessionId: turn.sessionId,
    event: {
      type: 'stream/chunk',
      data: { type: 'text-delta', index: 0, text: '\nDocument saved.' },
    },
  })
  send({
    type: 'agent:event',
    sessionId: turn.sessionId,
    event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  })
}

recordApply()
send({ type: 'ready', pid: process.pid, startedBundles: ['fake-docs'] })

process.on('message', (frame) => {
  if (frame.type === 'agent:start') {
    turn = frame
    lastRevision = frame.revision
    pending = 'propose'
    send({
      type: 'agent:event',
      sessionId: frame.sessionId,
      event: {
        type: 'stream/chunk',
        data: { type: 'text-delta', index: 0, text: 'Preparing the document edit.' },
      },
    })
    send({
      type: 'editor:request',
      id: `docs-propose-${frame.sessionId}`,
      target: target('docs-operation-1'),
      command: 'propose_ops',
      arguments: { ops: operations },
    })
    return
  }

  if (frame.type === 'approval:response' && frame.outcome === 'allowed-once') {
    if (pending === 'approve-save') {
      pending = 'save'
      send({
        type: 'editor:request',
        id: `docs-save-${turn.sessionId}`,
        target: target('docs-save-1'),
        command: 'save_document',
        arguments: { inPlace: true },
        approval: { id: frame.id, planHash: 'save-current-document-in-place' },
      })
      return
    }
    pending = 'apply'
    send({
      type: 'editor:request',
      id: `docs-apply-${turn.sessionId}`,
      target: target('docs-operation-1'),
      command: 'apply_ops',
      arguments: { ops: operations },
      approval: { id: frame.id, planHash: pendingPlanHash },
    })
    return
  }

  if (frame.type === 'editor:result') {
    lastRevision = frame.currentRevision ?? lastRevision
    if (pending === 'propose') {
      pendingPlanHash = frame.result?.data?.planHash
      pending = 'approve-apply'
      send({
        type: 'approval:request',
        id: `docs-approval-${turn.sessionId}`,
        sessionId: turn.sessionId,
        toolName: 'apply_document_operations',
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
      recordApply(frame.result)
      if (savedOnce) {
        finish()
        return
      }
      pending = 'approve-save'
      send({
        type: 'approval:request',
        id: `docs-save-approval-${turn.sessionId}`,
        sessionId: turn.sessionId,
        toolName: 'save_document',
        reason: 'Save the current document in place.',
        proposal: {
          planHash: 'save-current-document-in-place',
          summary: 'Save the current document in place.',
          targets: ['current document'],
          warnings: [],
        },
      })
      return
    }
    savedOnce = true
    finish()
    return
  }

  if (frame.type === 'shutdown') {
    send({ type: 'shutdown-complete' })
    process.disconnect?.()
  }
})
