/// <reference types="vite/client" />
import type { SlidesApi } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'
import type { SlidesBrowserHostHandle } from './browser-host-api'

declare global {
  interface Window {
    slidesApi: SlidesApi
    projectApi: ProjectApi
    nexusdeskSlidesHost?: SlidesBrowserHostHandle
  }
}

export {}
