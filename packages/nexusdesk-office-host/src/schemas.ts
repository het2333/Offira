import { z } from 'zod'

import { PROTOCOL_VERSION, type DocumentId, type Revision } from '@nexusdesk/protocol'

export const editorKindSchema = z.enum(['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'])
export const shellThemeSchema = z.enum(['light', 'dark', 'system'])
export const shellLanguageSchema = z.enum([
  'zh',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'th',
  'id',
  'ru',
  'ar',
  'pt',
  'it',
  'pl',
  'cs',
  'nl',
  'ms',
  'he',
  'hi',
  'zh-TW',
])

const documentIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as DocumentId)
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((value) => value as Revision)

export const hostCapabilitiesSchema = z
  .object({
    mode: z.enum(['browser', 'electron']),
    editors: z.array(editorKindSchema),
    nativeFilePicker: z.boolean(),
    browserImport: z.boolean(),
    revealInFileManager: z.boolean(),
    trash: z.boolean(),
    updater: z.boolean(),
    credentialStore: z.boolean(),
  })
  .readonly()

export const shellDocumentSummarySchema = z
  .object({
    documentId: documentIdSchema,
    title: z.string().min(1).max(512),
    editorType: editorKindSchema,
    revision: revisionSchema,
    dirty: z.boolean().optional(),
  })
  .readonly()

const homeTabSchema = z
  .object({
    id: z.literal('home'),
    kind: z.literal('home'),
    title: z.string().min(1).max(512),
    closable: z.literal(false),
    active: z.boolean(),
  })
  .readonly()

const documentTabSchema = z
  .object({
    id: z.string().min(1).max(512),
    kind: editorKindSchema,
    title: z.string().min(1).max(512),
    closable: z.literal(true),
    active: z.boolean(),
    documentId: documentIdSchema,
  })
  .readonly()

export const shellTabSummarySchema = z.discriminatedUnion('kind', [
  homeTabSchema,
  documentTabSchema,
])

const shellSettingsObjectSchema = z.object({
  language: shellLanguageSchema,
  theme: shellThemeSchema,
  onboardingSeen: z.boolean(),
})

export const shellSettingsSchema = shellSettingsObjectSchema.readonly()
export const shellSettingsPatchSchema = shellSettingsObjectSchema.partial().readonly()

export const shellBootstrapSchema = z
  .object({
    capabilities: hostCapabilitiesSchema,
    documents: z.array(shellDocumentSummarySchema),
    tabs: z.array(shellTabSummarySchema).min(1),
    settings: shellSettingsSchema,
  })
  .superRefine((value, context) => {
    if (value.tabs[0]?.id !== 'home' || value.tabs[0]?.kind !== 'home') {
      context.addIssue({
        code: 'custom',
        path: ['tabs', 0],
        message: 'Home must be the first tab.',
      })
    }

    const tabIds = new Set<string>()
    for (const [index, tab] of value.tabs.entries()) {
      if (tabIds.has(tab.id)) {
        context.addIssue({
          code: 'custom',
          path: ['tabs', index, 'id'],
          message: `Duplicate tab id: ${tab.id}`,
        })
      }
      tabIds.add(tab.id)
    }

    if (value.tabs.filter((tab) => tab.active).length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['tabs'],
        message: 'Exactly one tab must be active.',
      })
    }

    const documentIds = new Set(value.documents.map((document) => document.documentId))
    for (const [index, tab] of value.tabs.entries()) {
      if (tab.kind !== 'home' && !documentIds.has(tab.documentId)) {
        context.addIssue({
          code: 'custom',
          path: ['tabs', index, 'documentId'],
          message: `Tab references unknown document: ${tab.documentId}`,
        })
      }
    }
  })

export const hostErrorCodeSchema = z.enum([
  'AUTHENTICATION_REQUIRED',
  'INVALID_REQUEST',
  'UNSUPPORTED_CAPABILITY',
  'FILE_NOT_AUTHORIZED',
  'DOCUMENT_NOT_FOUND',
  'TAB_NOT_FOUND',
  'EDITOR_NOT_AVAILABLE',
  'HOST_DISCONNECTED',
  'INTERNAL_ERROR',
])

export const hostErrorSchema = z
  .object({
    code: hostErrorCodeSchema,
    message: z.string().min(1).max(2_000),
    retryable: z.boolean(),
    documentId: documentIdSchema.optional(),
  })
  .readonly()

export const activateTabRequestSchema = z.object({ tabId: z.string().min(1).max(512) }).readonly()
export const closeTabRequestSchema = activateTabRequestSchema
export const reorderTabRequestSchema = z
  .object({
    tabId: z.string().min(1).max(512),
    toIndex: z.number().int().nonnegative(),
  })
  .readonly()

export const fileSummarySchema = z
  .object({
    fileId: z.string().min(1).max(512),
    name: z.string().min(1).max(512),
    editorType: editorKindSchema,
    modifiedAt: z.number().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    starred: z.boolean(),
    missing: z.boolean().optional(),
  })
  .readonly()

export const fileListResponseSchema = z.object({ files: z.array(fileSummarySchema) }).readonly()

export const shellChangedEventSchema = z
  .object({
    type: z.literal('shell:changed'),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    sequence: z.number().int().positive(),
  })
  .strict()
  .readonly()

export type ShellBootstrapWire = z.infer<typeof shellBootstrapSchema>
