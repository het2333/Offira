import type { DocumentId, Revision } from '@nexusdesk/protocol'

export type EditorKind = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'
export type ShellTheme = 'light' | 'dark' | 'system'
export type ShellLanguage =
  | 'zh'
  | 'en'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'th'
  | 'id'
  | 'ru'
  | 'ar'
  | 'pt'
  | 'it'
  | 'pl'
  | 'cs'
  | 'nl'
  | 'ms'
  | 'he'
  | 'hi'
  | 'zh-TW'

export interface HostCapabilities {
  readonly mode: 'browser' | 'electron'
  readonly editors: readonly EditorKind[]
  readonly nativeFilePicker: boolean
  readonly browserImport: boolean
  readonly revealInFileManager: boolean
  readonly trash: boolean
  readonly updater: boolean
  readonly credentialStore: boolean
}

export interface ShellDocumentSummary {
  readonly documentId: DocumentId
  readonly title: string
  readonly editorType: EditorKind
  readonly revision: Revision
  readonly dirty?: boolean | undefined
}

export interface HomeTabSummary {
  readonly id: 'home'
  readonly kind: 'home'
  readonly title: string
  readonly closable: false
  readonly active: boolean
}

export interface DocumentTabSummary {
  readonly id: string
  readonly kind: EditorKind
  readonly title: string
  readonly closable: true
  readonly active: boolean
  readonly documentId: DocumentId
}

export type ShellTabSummary = HomeTabSummary | DocumentTabSummary

export interface ShellSettings {
  readonly language: ShellLanguage
  readonly theme: ShellTheme
  readonly onboardingSeen: boolean
}

export interface ShellSettingsPatch {
  readonly language?: ShellLanguage | undefined
  readonly theme?: ShellTheme | undefined
  readonly onboardingSeen?: boolean | undefined
}

export interface ShellBootstrap {
  readonly capabilities: HostCapabilities
  readonly documents: readonly ShellDocumentSummary[]
  readonly tabs: readonly ShellTabSummary[]
  readonly settings: ShellSettings
}

export interface ProductConfig {
  readonly id: string
  readonly name: string
  readonly editors: readonly EditorKind[]
  readonly features: {
    readonly mcp: boolean
    readonly cloudProjects: boolean
    readonly account: boolean
    readonly integrations: boolean
  }
}

export type HostErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_CAPABILITY'
  | 'FILE_NOT_AUTHORIZED'
  | 'DOCUMENT_NOT_FOUND'
  | 'TAB_NOT_FOUND'
  | 'EDITOR_NOT_AVAILABLE'
  | 'REVISION_CONFLICT'
  | 'CONTENT_TOO_LARGE'
  | 'INVALID_DOCUMENT_CONTENT'
  | 'HOST_DISCONNECTED'
  | 'INTERNAL_ERROR'

export interface HostErrorValue {
  readonly code: HostErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly documentId?: DocumentId
}

export type DocumentWriteResult = ShellDocumentSummary

export class HostError extends Error implements HostErrorValue {
  readonly name = 'HostError'
  readonly documentId?: DocumentId

  constructor(
    readonly code: HostErrorCode,
    message: string,
    readonly retryable: boolean,
    documentId?: DocumentId,
  ) {
    super(message)
    if (documentId !== undefined) this.documentId = documentId
  }
}

export interface FileSummary {
  readonly fileId: string
  readonly name: string
  readonly editorType: EditorKind
  readonly modifiedAt: number
  readonly sizeBytes: number
  readonly starred: boolean
  readonly missing?: boolean | undefined
}

export interface FileService {
  list(): Promise<readonly FileSummary[]>
  open(fileId: string): Promise<ShellBootstrap>
  toggleStar(fileId: string): Promise<readonly FileSummary[]>
  importFile?(): Promise<ShellBootstrap | undefined>
}

export interface DocumentService {
  list(): Promise<readonly ShellDocumentSummary[]>
  save(documentId: DocumentId): Promise<ShellDocumentSummary>
  close(documentId: DocumentId): Promise<ShellBootstrap>
}

export interface TabService {
  list(): Promise<readonly ShellTabSummary[]>
  activate(tabId: string): Promise<ShellBootstrap>
  close(tabId: string): Promise<ShellBootstrap>
  reorder(tabId: string, toIndex: number): Promise<ShellBootstrap>
  onChanged(listener: (tabs: readonly ShellTabSummary[]) => void): () => void
}

export interface SettingsService {
  get(): Promise<ShellSettings>
  update(patch: ShellSettingsPatch): Promise<ShellSettings>
  onChanged(listener: (settings: ShellSettings) => void): () => void
}

export interface AgentService {
  start(documentId: DocumentId, prompt: string): Promise<void>
  cancel(documentId: DocumentId): Promise<void>
}

export interface PlatformService {
  browse(): Promise<ShellBootstrap | undefined>
  revealFile(fileId: string): Promise<void>
  trashFiles(fileIds: readonly string[]): Promise<readonly FileSummary[]>
}

export interface OfficeHost {
  readonly capabilities: HostCapabilities
  bootstrap(): Promise<ShellBootstrap>
  readonly files: FileService
  readonly documents: DocumentService
  readonly tabs: TabService
  readonly settings: SettingsService
  readonly agent: AgentService
  readonly platform: PlatformService
}

export * from './schemas'
