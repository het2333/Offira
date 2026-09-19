import { describe, expect, it } from 'vitest'

import type { EditorKind } from '@nexusdesk/office-host'
import { DocumentDriverRegistry, type LocalDocumentDriver } from '../src/document-driver'

function fakeDriver(
  documentId: string,
  editorType: EditorKind = 'sheets',
): LocalDocumentDriver & { actions: Array<[string, unknown]> } {
  const actions: Array<[string, unknown]> = []
  return {
    document: {
      documentId,
      title: `${documentId}.test`,
      editorType,
      revision: 1,
    },
    actions,
    async bootstrap() {
      return { kind: editorType }
    },
    async execute(action, payload) {
      actions.push([action, payload])
      return { ok: true }
    },
    async close() {},
  }
}

describe('DocumentDriverRegistry', () => {
  it('routes bootstrap and actions to the driver owning the requested document', async () => {
    const docs = fakeDriver('doc-1', 'docs')
    const sheets = fakeDriver('sheet-1', 'sheets')
    const registry = new DocumentDriverRegistry([docs, sheets])

    expect(await registry.bootstrap('doc-1', 'http://127.0.0.1:1')).toMatchObject({
      kind: 'docs',
    })
    await registry.execute('sheet-1', 'read', { range: 'A1' })

    expect(sheets.actions).toEqual([['read', { range: 'A1' }]])
  })

  it('fails closed for unknown document ids and duplicate drivers', () => {
    expect(() => new DocumentDriverRegistry([fakeDriver('d1'), fakeDriver('d1')])).toThrow(
      /duplicate/i,
    )
    expect(() => new DocumentDriverRegistry([]).require('missing')).toThrowError(
      expect.objectContaining({ code: 'DOCUMENT_NOT_FOUND' }),
    )
  })

  it('closes every driver even when one driver rejects', async () => {
    const closed: string[] = []
    const first = fakeDriver('first')
    first.close = async () => {
      closed.push('first')
      throw new Error('first close failed')
    }
    const second = fakeDriver('second')
    second.close = async () => {
      closed.push('second')
    }

    await expect(new DocumentDriverRegistry([first, second]).close()).rejects.toThrow(
      'first close failed',
    )
    expect(closed).toEqual(['first', 'second'])
  })
})
