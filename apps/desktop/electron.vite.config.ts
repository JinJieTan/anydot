import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Workspace packages ship TypeScript source, so they must be bundled, not externalized.
const workspace = { exclude: ['@aitech/agent', '@aitech/core', '@aitech/db', '@aitech/protocol'] }

export default defineConfig({
  main: {
    build: {
      externalizeDeps: workspace,
      rollupOptions: {
        // ws's optional native addons: left unresolved, ws catches the failed require and uses JS.
        external: ['bufferutil', 'utf-8-validate'],
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
