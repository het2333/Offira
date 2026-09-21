import { describe, expect, it } from 'vitest'
import { OfficeRuntimeCarrier } from '../src/office-runtime-carrier'

describe('runtime native carrier', () => {
  it('prepares exactly one native request without starting an independent turn', async () => {
    const sent: any[] = []
    const calls: any[] = []
    const target = { clientId: 'c1', documentId: 'doc1', editorType: 'sheets', revision: 0 }
    const carrier = new OfficeRuntimeCarrier({
      target: () => target as never,
      send: (frame) => sent.push(frame),
      dispatch: async (endpoint, payload) => { calls.push({ endpoint, payload }); return { ok: true, value: {} } },
      open: async function* () {},
    })
    const frame = (value: object, context?: unknown) => ({ type: 'office:client', protocolVersion: 1, id: 'outer', clientId: 'c1', sessionId: 'session1', frame: { protocolVersion: 1, documentId: 'doc1', ...value }, ...(context ? { context } : {}) }) as any
    const context = { hostId: 'host1', documentId: 'doc1', editorType: 'sheets', revision: 0, selection: { kind: 'sheets', sheetId: 'sheet1', a1: 'C1:C3' } }
    await carrier.handle(frame({ type: 'harness:prepare', id: 'p1', requestId: 'r1', revision: 0, selection: context.selection }, context))
    expect(calls).toHaveLength(0)
    expect(sent[0].frame.type).toBe('harness:prepared')
    const prompt = frame({ type: 'harness:rpc', id: 'call1', endpoint: 'session/prompt', payload: { args: { request: { sessionId: 'session1', requestId: 'r1', mode: 'queue', content: [{ type: 'text', text: '求和' }] } } } })
    await carrier.handle(prompt)
    expect(calls).toHaveLength(1)
    expect(calls[0].payload.args.request.requestId).toBe('r1')
    expect(calls[0].payload.args.request.content[0].text).toContain('C1:C3')
    expect(calls[0].payload.args.request.content[1].text).toBe('求和')
    await carrier.handle(prompt)
    expect(calls).toHaveLength(1)
    expect(sent.at(-1).frame.type).toBe('harness:error')
    await carrier.handle(frame({ type: 'harness:prepare', id: 'p2', requestId: 'r1', revision: 0, selection: context.selection }, context))
    expect(sent.at(-1).frame.type).toBe('harness:error')
    carrier.close()
  })
})
