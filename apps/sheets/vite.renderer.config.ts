import react from '@vitejs/plugin-react'
import { defineConfig, type ServerOptions } from 'vite'

interface RendererEnvironment {
  NEXUSDESK_LOCAL_WEB?: string
  NEXUSDESK_LOCAL_ORIGIN?: string
  SHEETS_DEV_PORT?: string
}

export function createRendererServerOptions(environment: RendererEnvironment): ServerOptions {
  const browserMode = environment.NEXUSDESK_LOCAL_WEB === '1'
  const origin = environment.NEXUSDESK_LOCAL_ORIGIN
  if (browserMode && !origin) {
    throw new Error('NEXUSDESK_LOCAL_ORIGIN is required when NEXUSDESK_LOCAL_WEB=1')
  }
  const proxy = origin === undefined
    ? undefined
    : {
        '/api': { target: origin },
        '/ws': { target: origin.replace(/^http/, 'ws'), ws: true },
      }
  return {
    port: Number(environment.SHEETS_DEV_PORT) || 5174,
    strictPort: true,
    ...(proxy === undefined ? {} : { proxy }),
  }
}

// renderer-only dev server (embedded by the shell via SHEETS_RENDERER_URL for HMR; no standalone Electron)
export default defineConfig({
  root: 'src/renderer',
  base: '/sheets/',
  plugins: [react()],
  server: createRendererServerOptions(process.env),
})
