import react from '@vitejs/plugin-react'
import { inlineHarnessBuild } from '../../packages/nexusdesk-harness-panel-ui/src/vite-inline'
import { defineConfig, type ServerOptions } from 'vite'

interface RendererEnvironment {
  NEXUSDESK_LOCAL_WEB?: string
  NEXUSDESK_LOCAL_ORIGIN?: string
  DOCS_DEV_PORT?: string
}

export function createRendererServerOptions(environment: RendererEnvironment): ServerOptions {
  const browserMode = environment.NEXUSDESK_LOCAL_WEB === '1'
  const origin = environment.NEXUSDESK_LOCAL_ORIGIN
  if (browserMode && !origin) {
    throw new Error('NEXUSDESK_LOCAL_ORIGIN is required when NEXUSDESK_LOCAL_WEB=1')
  }
  const proxy =
    origin === undefined
      ? undefined
      : {
          '/api': { target: origin },
          '/ws': { target: origin.replace(/^http/, 'ws'), ws: true },
        }
  return {
    port: Number(environment.DOCS_DEV_PORT) || 5173,
    strictPort: true,
    ...(proxy === undefined ? {} : { proxy }),
  }
}

// renderer-only dev server (embedded by the shell via DOCS_RENDERER_URL for HMR; no standalone Electron)
export default defineConfig({
  root: 'src/renderer',
  base: '/docs/',
  plugins: [inlineHarnessBuild(), react()],
  server: createRendererServerOptions(process.env),
  build: {
    outDir: '../../out/web',
    emptyOutDir: true,
  },
})
