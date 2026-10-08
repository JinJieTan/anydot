import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Workspace packages ship TypeScript source, so they must be bundled, not externalized.
const workspace = { exclude: ['@aitech/core', '@aitech/db'] }

export default defineConfig({
  main: {
    build: {
      externalizeDeps: workspace,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          agent: resolve(__dirname, 'src/agent/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: workspace,
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
})
