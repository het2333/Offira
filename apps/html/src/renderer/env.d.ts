/// <reference types="vite/client" />

import type { ProjectApi } from '@genoffice/project-store'
import type { HtmlApi } from '../shared/ipc'
import type { HtmlBrowserHostHandle } from './browser-host-api'

declare global {
  interface Window {
    htmlApi: HtmlApi
    nexusdeskHtmlHost?: HtmlBrowserHostHandle
    projectApi?: Pick<ProjectApi, 'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'>
  }
}

export {}
