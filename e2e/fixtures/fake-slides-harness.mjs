let turn
let pending
let planHash
let operation
let revision = 1
let contentVersion = 1

const send = (frame) => process.send?.({ protocolVersion: 1, ...frame })
const target = (operationId) => ({
  sessionId: turn.sessionId,
  documentId: turn.documentId,
  editorType: 'slides',
  revision,
  operationId,
  clientId: turn.clientId,
})

send({ type: 'ready', pid: process.pid, startedBundles: ['fake-slides'] })

process.on('message', (frame) => {
  if (frame.type === 'agent:start') {
    turn = frame
    revision = frame.revision
    pending = 'read'
    send({ type: 'editor:request', id: 'slides-read-1', target: target('slides-read-1'), command: 'read_presentation', arguments: {} })
    return
  }
  if (frame.type === 'approval:response' && frame.outcome === 'allowed-once') {
    if (pending === 'approve-apply') {
      pending = 'apply'
      send({ type: 'editor:request', id: 'slides-apply-1', target: target('slides-operation-1'), command: 'apply_ops', arguments: { ops: [operation] }, approval: { id: 'slides-approval-1', planHash } })
    } else if (pending === 'approve-save') {
      pending = 'save'
      send({ type: 'editor:request', id: 'slides-save-1', target: target('slides-save-operation-1'), command: 'save_presentation', arguments: { inPlace: true, contentVersion }, approval: { id: 'slides-save-approval-1', planHash } })
    }
    return
  }
  if (frame.type === 'editor:result') {
    revision = frame.currentRevision ?? revision
    if (pending === 'read') {
      contentVersion = frame.result?.data?.contentVersion ?? contentVersion
      const slides = frame.result?.data?.slides
      const node = Array.isArray(slides) ? slides[0]?.nodes?.find((candidate) => candidate?.type === 'text' && typeof candidate.sourceId === 'string') : undefined
      if (!node) throw new Error('Slides read did not expose a text element.')
      operation = { op: 'setText', target: { slide: 0, el: node.sourceId }, paragraphs: [{ runs: [{ text: 'Edited by approved Harness' }] }] }
      pending = 'propose'
      send({ type: 'editor:request', id: 'slides-propose-1', target: target('slides-operation-1'), command: 'propose_ops', arguments: { ops: [operation] } })
      return
    }
    if (pending === 'propose') {
      planHash = frame.result?.data?.planHash
      pending = 'approve-apply'
      send({ type: 'approval:request', id: 'slides-approval-1', sessionId: turn.sessionId, toolName: 'apply_presentation_operations', proposal: { operationId: 'slides-operation-1', planHash, summary: frame.result?.summary, targets: frame.result?.data?.targets ?? [], warnings: [] } })
      return
    }
    if (pending === 'apply') {
      contentVersion = frame.result?.data?.contentVersion ?? contentVersion
      pending = 'propose-save'
      send({ type: 'editor:request', id: 'slides-propose-save-1', target: target('slides-save-operation-1'), command: 'propose_save', arguments: {} })
      return
    }
    if (pending === 'propose-save') {
      contentVersion = frame.result?.data?.contentVersion ?? contentVersion
      planHash = frame.result?.data?.planHash
      pending = 'approve-save'
      send({ type: 'approval:request', id: 'slides-save-approval-1', sessionId: turn.sessionId, toolName: 'save_presentation', proposal: { operationId: 'slides-save-operation-1', planHash, summary: frame.result?.data?.summary, targets: frame.result?.data?.targets ?? [], warnings: [] } })
      return
    }
    if (pending === 'save') {
      send({ type: 'agent:event', sessionId: turn.sessionId, event: { type: 'stream/chunk', data: { type: 'text-delta', index: 0, text: 'Presentation saved.' } } })
      send({ type: 'agent:event', sessionId: turn.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } })
    }
    return
  }
  if (frame.type === 'shutdown') { send({ type: 'shutdown-complete' }); process.disconnect?.() }
})
