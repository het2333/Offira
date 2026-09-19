/// <reference types="vite/client" />

import type { DesktopApi } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'
import type { AgentApi } from '@nexusdesk/web-client'
import type { DocsBrowserHostHandle } from './browser-host-api'

declare global {
  interface Window {
    desktop: DesktopApi
    projectApi?: ProjectApi
    agentApi?: AgentApi
    nexusdeskDocsHost?: DocsBrowserHostHandle
  }
}

export {}
