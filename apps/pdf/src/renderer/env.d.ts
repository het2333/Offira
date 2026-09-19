/// <reference types="vite/client" />

import type { PdfApi } from '../shared/ipc'
import type { PdfBrowserHostHandle } from './browser-host-api'
import type { AgentApi } from '@nexusdesk/web-client'

declare global {
  interface Window {
    pdfApi: PdfApi
    agentApi?: AgentApi
    nexusdeskPdfHost?: PdfBrowserHostHandle
  }
}

export {}
