import { writeFileSync } from 'node:fs'

let turn
let pending
let lastRevision = 1
let planHash
let savePlanHash
const applyCountPath = process.argv[2]
const applied = new Set()

const send = (frame) => process.send?.({ protocolVersion: 1, ...frame })
const target = (operationId) => ({
  sessionId: turn.sessionId,
  documentId: turn.documentId,
  editorType: 'pdf',
  revision: lastRevision,
  operationId,
  clientId: turn.clientId,
})
const recordApply = (result) => {
  const id = result?.transactionId ?? 'pdf-approved-markup-1'
  applied.add(id)
  writeFileSync(applyCountPath, JSON.stringify({ applyCount: applied.size }))
}
const finish = () => {
  send({
    type: 'agent:event',
    sessionId: turn.sessionId,
    event: {
      type: 'stream/chunk',
      data: { type: 'text-delta', index: 0, text: 'PDF saved.' },
    },
  })
  send({
    type: 'agent:event',
    sessionId: turn.sessionId,
    event: {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    },
  })
}

writeFileSync(applyCountPath, JSON.stringify({ applyCount: 0 }))

send({ type: 'ready', pid: process.pid, startedBundles: ['fake-pdf'] })

process.on('message', (frame) => {
  if (frame.type === 'agent:start') {
    turn = frame
    lastRevision = frame.revision
    pending = 'propose-markup'
    send({
      type: 'editor:request',
      id: 'pdf-propose-markup',
      target: target('pdf-operation-1'),
      command: 'propose_ops',
      arguments: {
        ops: [{ op: 'markup_pdf_text', page: 1, text: 'NexusDesk', type: 'highlight' }],
      },
    })
    return
  }
  if (frame.type === 'approval:response' && frame.outcome === 'allowed-once') {
    if (pending === 'approve-markup') {
      pending = 'apply-markup'
      send({
        type: 'editor:request',
        id: 'pdf-apply-markup',
        target: target('pdf-operation-1'),
        command: 'apply_ops',
        arguments: {},
        approval: { id: 'pdf-approval-1', planHash },
      })
      return
    }
    if (pending === 'approve-save') {
      pending = 'save'
      send({
        type: 'editor:request',
        id: 'pdf-save',
        target: target('pdf-save-1'),
        command: 'save_pdf',
        arguments: { inPlace: true },
        approval: { id: 'pdf-save-approval-1', planHash: savePlanHash },
      })
      return
    }
  }
  if (frame.type === 'editor:result') {
    lastRevision = frame.currentRevision ?? lastRevision
    if (pending === 'propose-markup') {
      planHash = frame.result?.data?.planHash
      pending = 'approve-markup'
      send({
        type: 'approval:request',
        id: 'pdf-approval-1',
        sessionId: turn.sessionId,
        toolName: 'markup_pdf_text',
        reason: frame.result?.summary,
        proposal: {
          planHash,
          summary: frame.result?.data?.summary,
          targets: frame.result?.data?.targets ?? [],
          warnings: frame.result?.warnings ?? [],
          operationId: 'pdf-operation-1',
        },
      })
      return
    }
    if (pending === 'apply-markup') {
      if (!frame.result?.ok) throw new Error(frame.result?.summary ?? 'PDF markup failed')
      recordApply(frame.result)
      pending = 'propose-save'
      send({
        type: 'editor:request',
        id: 'pdf-propose-save',
        target: target('pdf-save-1'),
        command: 'propose_save',
        arguments: {},
      })
      return
    }
    if (pending === 'propose-save') {
      savePlanHash = frame.result?.data?.planHash
      pending = 'approve-save'
      send({
        type: 'approval:request',
        id: 'pdf-save-approval-1',
        sessionId: turn.sessionId,
        toolName: 'save_pdf',
        reason: frame.result?.summary,
        proposal: {
          planHash: savePlanHash,
          summary: frame.result?.data?.summary,
          targets: frame.result?.data?.targets ?? [],
          warnings: frame.result?.warnings ?? [],
          operationId: 'pdf-save-1',
        },
      })
      return
    }
    if (pending === 'save') finish()
    return
  }
  if (frame.type === 'shutdown') {
    send({ type: 'shutdown-complete' })
    process.disconnect?.()
  }
})
