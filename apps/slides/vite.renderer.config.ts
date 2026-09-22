import react from '@vitejs/plugin-react'
import { inlineHarnessBuild } from '../../packages/nexusdesk-harness-panel-ui/src/vite-inline'
import { defineConfig } from 'vite'

// renderer-only dev server (embedded by the shell via SLIDES_RENDERER_URL for HMR; no standalone Electron)
export default defineConfig({
  root: 'src/renderer',
  base: '/slides/',
  plugins: [inlineHarnessBuild(), react()],
  server: {
    port: Number(process.env.SLIDES_DEV_PORT) || 5175,
    strictPort: true,
  },
  build: {
    outDir: '../../out/web',
    emptyOutDir: true,
  },
})
