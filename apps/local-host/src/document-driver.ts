import { HostError, type EditorKind, type ShellDocumentSummary } from '@nexusdesk/office-host'

export interface LocalDocument {
  documentId: string
  title: string
  editorType: EditorKind
  revision: number
  path?: string
}

export interface LocalDocumentDriver {
  readonly document: LocalDocument
  bootstrap(origin: string): Promise<unknown>
  execute(action: string, payload: unknown): Promise<unknown>
  readContent?(): Promise<{ bytes: Uint8Array; contentType: string }>
  writeContent?(bytes: Uint8Array, expectedRevision: number): Promise<ShellDocumentSummary>
  close(): Promise<void>
}

export class DocumentDriverRegistry {
  readonly #drivers = new Map<string, LocalDocumentDriver>()

  constructor(drivers: readonly LocalDocumentDriver[]) {
    for (const driver of drivers) {
      if (this.#drivers.has(driver.document.documentId)) {
        throw new Error(`Duplicate document driver id: ${driver.document.documentId}`)
      }
      this.#drivers.set(driver.document.documentId, driver)
    }
  }

  list(): readonly LocalDocument[] {
    return [...this.#drivers.values()].map((driver) => driver.document)
  }

  require(documentId: string): LocalDocumentDriver {
    const driver = this.#drivers.get(documentId)
    if (driver === undefined) {
      throw new HostError(
        'DOCUMENT_NOT_FOUND',
        `Document ${documentId} is not registered with this Local Host.`,
        false,
      )
    }
    return driver
  }

  bootstrap(documentId: string, origin: string): Promise<unknown> {
    return this.require(documentId).bootstrap(origin)
  }

  execute(documentId: string, action: string, payload: unknown): Promise<unknown> {
    return this.require(documentId).execute(action, payload)
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#drivers.values()].map((driver) => driver.close()),
    )
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed !== undefined) throw failed.reason
  }
}
