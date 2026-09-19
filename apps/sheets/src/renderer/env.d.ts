declare module '*.md?raw' {
  const content: string
  export default content
}

import type { DesktopApi } from '../shared/desktop-api'
import type { ProjectApi } from '@genoffice/project-store'
import type { AgentApi } from '@nexusdesk/web-client'
import type { BrowserHostBootstrap, BrowserHostHandle } from './browser-host-api'

declare global {
  interface Window {
    readonly desktopApi: DesktopApi
    readonly projectApi: ProjectApi
    readonly agentApi?: AgentApi
    readonly nexusdeskBootstrap?: BrowserHostBootstrap
    readonly nexusdeskBrowserHost?: BrowserHostHandle
  }
}

export {}
