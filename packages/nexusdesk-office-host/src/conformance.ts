import type { OfficeHost } from './index'

export interface OfficeHostConformanceResult {
  readonly mode: 'browser' | 'electron'
  readonly activeTabId: string
  readonly language: string
}

/**
 * Framework-neutral semantic probe reused by every OfficeHost adapter suite.
 * It deliberately exercises only read behavior so the same fixture can serve
 * browser and desktop adapters without leaving persisted mutations behind.
 */
export async function officeHostConformance(
  factory: () => OfficeHost | Promise<OfficeHost>,
): Promise<OfficeHostConformanceResult> {
  const host = await factory()
  const bootstrap = await host.bootstrap()
  const active = bootstrap.tabs.filter((tab) => tab.active)
  if (active.length !== 1 || active[0] === undefined) {
    throw new Error('OfficeHost must expose exactly one active tab.')
  }
  const settings = await host.settings.get()
  const tabs = await host.tabs.list()
  if (!tabs.some((tab) => tab.id === active[0]!.id)) {
    throw new Error('OfficeHost tab service disagrees with bootstrap state.')
  }
  return {
    mode: bootstrap.capabilities.mode,
    activeTabId: active[0].id,
    language: settings.language,
  }
}
