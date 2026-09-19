import { describe, expect, it } from 'vitest'

import { hostErrorSchema, shellBootstrapSchema } from '../src/schemas'

const baseCapabilities = {
  mode: 'browser',
  editors: ['sheets'],
  nativeFilePicker: false,
  browserImport: true,
  revealInFileManager: false,
  trash: false,
  updater: false,
  credentialStore: false,
} as const

const settings = {
  language: 'zh',
  theme: 'system',
  onboardingSeen: true,
} as const

const homeTab = {
  id: 'home',
  kind: 'home',
  title: 'Home',
  closable: false,
  active: true,
} as const

describe('Office Host wire schemas', () => {
  it('accepts a valid Shell bootstrap', () => {
    expect(
      shellBootstrapSchema.parse({
        capabilities: baseCapabilities,
        documents: [{ documentId: 'd1', title: 'Book.xlsx', editorType: 'sheets', revision: 0 }],
        tabs: [
          homeTab,
          {
            id: 'document:d1',
            kind: 'sheets',
            title: 'Book.xlsx',
            closable: true,
            active: false,
            documentId: 'd1',
          },
        ],
        settings,
      }),
    ).toMatchObject({ documents: [{ documentId: 'd1' }] })
  })

  it('rejects unsupported editor kinds and duplicate tab ids', () => {
    expect(() =>
      shellBootstrapSchema.parse({
        capabilities: baseCapabilities,
        documents: [{ documentId: 'd1', title: 'Book.xlsx', editorType: 'unknown', revision: 0 }],
        tabs: [homeTab],
        settings,
      }),
    ).toThrow()
    expect(() =>
      shellBootstrapSchema.parse({
        capabilities: baseCapabilities,
        documents: [],
        tabs: [homeTab, homeTab],
        settings,
      }),
    ).toThrow(/duplicate/i)
  })

  it('requires exactly one active tab with Home pinned first', () => {
    expect(() =>
      shellBootstrapSchema.parse({
        capabilities: baseCapabilities,
        documents: [],
        tabs: [{ ...homeTab, active: false }],
        settings,
      }),
    ).toThrow(/active/i)
    expect(() =>
      shellBootstrapSchema.parse({
        capabilities: baseCapabilities,
        documents: [],
        tabs: [{ ...homeTab, id: 'other' }],
        settings,
      }),
    ).toThrow(/home/i)
  })

  it('rejects tabs that reference unknown documents', () => {
    expect(() =>
      shellBootstrapSchema.parse({
        capabilities: baseCapabilities,
        documents: [],
        tabs: [
          { ...homeTab, active: false },
          {
            id: 'document:d1',
            kind: 'sheets',
            title: 'Book.xlsx',
            closable: true,
            active: true,
            documentId: 'd1',
          },
        ],
        settings,
      }),
    ).toThrow(/unknown document/i)
  })

  it('represents unsupported platform actions explicitly', () => {
    expect(
      hostErrorSchema.parse({
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'Unavailable in browser mode',
        retryable: false,
      }),
    ).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })
})
