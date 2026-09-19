import { describe, expect, it } from 'vitest'

import { AuthorizedFiles } from '../src/authorized-files'

const workbook = {
  documentId: 'document-1',
  title: 'Forecast.xlsx',
  editorType: 'sheets' as const,
  revision: 0,
  path: '/private/authorized/Forecast.xlsx',
}

describe('AuthorizedFiles', () => {
  it('resolves registered file ids without exposing the path in summaries', () => {
    const files = new AuthorizedFiles([workbook])

    expect(files.require('document-1')).toMatchObject({ path: workbook.path })
    expect(files.list()).toEqual([
      expect.objectContaining({ fileId: 'document-1', name: 'Forecast.xlsx' }),
    ])
    expect(files.list()[0]).not.toHaveProperty('path')
  })

  it('rejects file ids outside the authorized registry', () => {
    const files = new AuthorizedFiles([workbook])

    expect(() => files.require('file-not-authorized')).toThrowError(
      expect.objectContaining({ code: 'FILE_NOT_AUTHORIZED' }),
    )
  })
})
