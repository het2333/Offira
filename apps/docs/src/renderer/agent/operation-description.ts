import type { JsonValue } from '@nexusdesk/protocol'

/** Describe the exact proposed DSL, never a model's claimed intent. */
export function describeDocumentOperation(operation: JsonValue): string {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return '无法识别的修改'
  const target = operation.target && typeof operation.target === 'object' && !Array.isArray(operation.target)
    ? operation.target : {}
  const indexes = Array.isArray(target.blockIndexes) ? target.blockIndexes.filter(n => typeof n === 'number') : []
  const location = indexes.length ? `第 ${indexes.map(n => Number(n) + 1).join('、')} 个内容块`
    : typeof target.containsText === 'string' ? `包含「${target.containsText}」的内容`
    : target.scope === 'selection' ? '当前选区' : '全文'
  const quote = (value: JsonValue | undefined) => {
    const text = typeof value === 'string' ? value : ''
    if (!text) return '（空文本）'
    if (/^\u3000+$/.test(text)) return `（${text.length} 个全角空格）`
    if (/^ +$/.test(text)) return `（${text.length} 个半角空格）`
    return `「${text}」`
  }
  if (operation.op === 'findReplace') return `${location}\n${quote(operation.find)} → ${quote(operation.replace)}`
  const names: Record<string, string> = { setFont: '修改字体', setParagraphFormat: '调整段落格式',
    setHeadingLevel: '设置标题级别', deleteBlocks: '删除内容块', moveBlocks: '移动内容块',
    setList: '设置列表', clearList: '取消列表', setImageProperties: '调整图片' }
  const fields = Object.fromEntries(Object.entries(operation).filter(([key]) => key !== 'op' && key !== 'target'))
  return `${location}：${names[String(operation.op)] ?? '修改内容'}\n${JSON.stringify(fields)}`
}
