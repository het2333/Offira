import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, normalizePath } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

interface RendererEnvironment {
  NEXUSDESK_LOCAL_WEB?: string
  NEXUSDESK_LOCAL_ORIGIN?: string
  PDF_DEV_PORT?: string
}

function serverOptions(environment: RendererEnvironment) {
  const origin = environment.NEXUSDESK_LOCAL_ORIGIN
  if (environment.NEXUSDESK_LOCAL_WEB === '1' && !origin) {
    throw new Error('NEXUSDESK_LOCAL_ORIGIN is required when NEXUSDESK_LOCAL_WEB=1')
  }
  return {
    port: Number(environment.PDF_DEV_PORT) || 5176,
    strictPort: true,
    ...(origin === undefined
      ? {}
      : { proxy: { '/api': { target: origin }, '/ws': { target: origin.replace(/^http/, 'ws'), ws: true } } }),
  }
}

// renderer-only dev server (embedded by shell via PDF_RENDERER_URL for HMR; no standalone Electron)
const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(dirname(require.resolve('pdfjs-dist/package.json')))
// vite-plugin-static-copy globs require POSIX separators; join() breaks on Windows
const pdfjsDir = (sub: string) => normalizePath(join(pdfjsRoot, 'pdfjs-dist', sub))

export default defineConfig({
  root: 'src/renderer',
  base: '/pdf/',
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: pdfjsDir('cmaps'), dest: 'pdfjs' },
        { src: pdfjsDir('standard_fonts'), dest: 'pdfjs' },
        { src: pdfjsDir('wasm'), dest: 'pdfjs' },
      ],
    }),
  ],
  server: serverOptions(process.env),
  build: {
    outDir: '../../out/web',
    emptyOutDir: true,
  },
})
