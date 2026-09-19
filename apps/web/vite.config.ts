import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.NEXUSDESK_LOCAL_ORIGIN ?? 'http://127.0.0.1:43123' },
      '/sheets': { target: process.env.SHEETS_RENDERER_URL ?? 'http://127.0.0.1:5174' },
    },
  },
})
