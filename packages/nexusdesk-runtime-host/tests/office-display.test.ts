import { expect, test } from 'vitest'
import { projectOfficeDisplay } from '../src/office-display'

const context = { type: 'text', text: 'NexusDesk Office context (Host-validated and frozen at submission):\n{"documentId":"doc-1","editorType":"sheets","revision":1,"selection":null}' }
test('removes only the host context part from displayed user messages without changing model history', () => {
  const message = { role: 'user', source: { kind: 'user' }, content: [context, { type: 'text', text: '你好' }] }
  const frame = { records: [{ data: { message } }] }
  expect(projectOfficeDisplay(frame, 'doc-1').records[0]!.data.message.content).toEqual([{ type: 'text', text: '你好' }])
  expect(message.content).toHaveLength(2)
})
test('preserves other documents, assistant output, malformed prefixes and ordinary user text', () => {
  for (const message of [
    { role: 'assistant', content: [context, { type: 'text', text: '你好' }] },
    { role: 'user', content: [{ type: 'text', text: context.text + '你好' }] },
    { role: 'user', content: [{ type: 'text', text: '你好' }, context] },
  ]) expect(projectOfficeDisplay(message, 'doc-1')).toEqual(message)
  const other = { role: 'user', content: [context, { type: 'text', text: '你好' }] }
  expect(projectOfficeDisplay(other, 'doc-2')).toEqual(other)
})
