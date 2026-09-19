/// <reference types="vite/client" />

import type { ProjectApi } from '@genoffice/project-store'
import type { MarkdownApi } from '../shared/ipc'
import type { MarkdownBrowserHostHandle } from './browser-host-api'

declare global {
  interface Window {
    markdownApi: MarkdownApi
    nexusdeskMarkdownHost?: MarkdownBrowserHostHandle
    projectApi?: Pick<ProjectApi, 'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'>
  }
}

export {}
