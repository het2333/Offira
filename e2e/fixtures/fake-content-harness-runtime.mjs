import { appendFileSync, writeFileSync } from 'node:fs'

let turn
let pending
let planHash
let revision = 1
const operationsByEditor = {
  markdown: [{ op: 'insertContent', after: 0, markdown: 'Agent' }],
  html: [{ op: 'str_replace', old: 'Manual', new: 'Manual Agent' }],
}
const countPath = process.argv[2]
const trace = (value) => appendFileSync('/tmp/nexusdesk-content-runtime.log', `${value}\n`)
const applied = new Set()
const send = (frame) => process.send?.({ protocolVersion: 1, ...frame })
const target = (operationId) => ({ sessionId: turn.sessionId, documentId: turn.documentId, editorType: turn.editorType, revision, operationId, clientId: turn.clientId })
const record = (result) => { if (typeof result?.transactionId === 'string') applied.add(result.transactionId); writeFileSync(countPath, JSON.stringify({ applyCount: applied.size })) }
record()
send({ type: 'ready', pid: process.pid, startedBundles: ['fake-content'] })

process.on('message', (frame) => {
  trace(`${frame.type}:${frame.id ?? ''}:${pending ?? ''}`)
  if (frame.type === 'agent:start') {
    turn = frame; revision = frame.revision; pending = 'propose'
    send({ type: 'editor:request', id: 'content-propose', target: target('content-operation'), command: 'propose_ops', arguments: { ops: operationsByEditor[turn.editorType] } })
  } else if (frame.type === 'approval:response' && frame.outcome === 'allowed-once') {
    if (pending === 'apply') {
      pending = 'save'
      send({ type: 'editor:request', id: 'content-save', target: target('content-save'), command: turn.editorType === 'markdown' ? 'save_markdown' : 'save_html', arguments: { inPlace: true }, approval: { id: frame.id, planHash: turn.editorType === 'markdown' ? 'save-current-markdown-in-place' : 'save-current-html-in-place' } })
    } else {
      pending = 'apply'
      send({ type: 'editor:request', id: 'content-apply', target: target('content-operation'), command: 'apply_ops', arguments: { ops: operationsByEditor[turn.editorType] }, approval: { id: frame.id, planHash } })
    }
  } else if (frame.type === 'editor:result') {
    revision = frame.currentRevision ?? revision
    if (pending === 'propose') {
      planHash = frame.result?.data?.planHash
      trace(`proposal:${String(planHash)}`)
      send({ type: 'approval:request', id: 'content-approval', sessionId: turn.sessionId, toolName: 'apply_content_operations', proposal: { operationId: 'content-operation', planHash, summary: frame.result?.summary, targets: frame.result?.data?.targets ?? [], warnings: [] } })
    } else if (pending === 'apply') {
      trace(`apply:${String(frame.result?.ok)}:${frame.result?.summary ?? ''}`)
      if (!frame.result?.ok) throw new Error(frame.result?.summary)
      record(frame.result)
      send({ type: 'approval:request', id: 'content-save-approval', sessionId: turn.sessionId, toolName: 'save_content', proposal: { operationId: 'content-save', planHash: turn.editorType === 'markdown' ? 'save-current-markdown-in-place' : 'save-current-html-in-place', summary: 'Save current document.', targets: ['current document'], warnings: [] } })
    } else {
      trace(`save:${String(frame.result?.ok)}:${frame.result?.summary ?? ''}`)
      send({ type: 'agent:event', sessionId: turn.sessionId, event: { type: 'stream/chunk', data: { type: 'text-delta', index: 0, text: 'Document saved.' } } })
      send({ type: 'agent:event', sessionId: turn.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } })
    }
  } else if (frame.type === 'shutdown') { send({ type: 'shutdown-complete' }); process.disconnect?.() }
})
