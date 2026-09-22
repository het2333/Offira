import { describe, expect, it } from 'vitest'
import { describeDocumentOperation } from '../src/renderer/agent/operation-description'

describe('approval operation descriptions', () => {
  it('shows exact replacement and one-based locations', () => {
    expect(describeDocumentOperation({ op: 'findReplace', find: '7月', replace: '8月', target: { blockIndexes: [2] } }))
      .toBe('第 3 个内容块\n「7月」 → 「8月」')
  })
  it('makes whitespace deletion visible', () => {
    expect(describeDocumentOperation({ op: 'findReplace', find: '　　', replace: '' }))
      .toBe('全文\n（2 个全角空格） → （空文本）')
  })
  it('does not hide replacement suffixes', () => {
    const value = '长'.repeat(170) + '末尾'
    expect(describeDocumentOperation({ op: 'findReplace', find: value, replace: '新文' })).toContain(value)
  })
})
