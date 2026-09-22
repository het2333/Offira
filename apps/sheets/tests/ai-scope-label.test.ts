import { expect, test } from 'vitest'
import { scopeLabel } from '../src/renderer/ai/AiChatPanel'

test('a bounded cell selection is described by its range rather than the first cell value', () => {
  const t = ((key: string, values: Record<string, unknown>) => `${key}:${values.range ?? values.name}`) as any
  expect(scopeLabel('A1:A3', ['1'], t)).toBe('aiScopeRange:A1:A3')
  expect(scopeLabel('B2', ['Revenue'], t)).toBe('aiScopeRange:B2')
  expect(scopeLabel('A:A', ['Revenue'], t)).toBe('aiScopeColumn:Revenue')
})
