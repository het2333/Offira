export { AppFrame, AppFrame as SharedShell } from './AppFrame'
export { Home } from './Home'
export { IntegrationsPane, mcpClaudeCommand, mcpConfigJson, mcpLaunch } from './IntegrationsPane'
export { McpServerSection } from './McpServerSection'
export { Onboarding } from './Onboarding'
export { SettingsModal, type SettingsModalProps } from './SettingsModal'
export { StarPromptCard } from './StarPromptCard'
export { TabBar } from './TabBar'
export { fileCountKey, timelineCountKey, visiblePageCount } from './counts'
export { LocaleProvider, useI18n } from './locale'
export {
  OfficeHostProvider,
  useOfficeHost,
  useShellPlatform,
  type ShellPlatformServices,
} from './office-host-context'
export { strings } from './strings'
export {
  GENOFFICE_PRODUCT_CONFIG,
  NEXUSDESK_PRODUCT_CONFIG,
  ProductConfigProvider,
  useProductConfig,
} from './product-config'
export { UnsupportedAction, unsupportedCapability } from './UnsupportedAction'
export type * from './platform/home-api'
export type * from './platform/integrations-api'
export type * from './platform/tabs-api'
