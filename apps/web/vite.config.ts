import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin } from 'vite'
import desktop from '../desktop/package.json' with { type: 'json' }
import { ARTIFACT_CSP } from './src/artifact-csp'

// Served next to the landing page at anydot.app/app/; override with VITE_BASE when hosting elsewhere.
const base = process.env.VITE_BASE ?? '/app/'

/**
 * Dev server stand-ins for what nginx does in production (see README.md):
 * artifact.html gets its sandboxing CSP, and the service worker may control
 * the whole app although Vite serves it from src/.
 */
function devHeaders(): Plugin {
  const headers: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.startsWith(`${base}artifact.html`))
      res.setHeader('Content-Security-Policy', ARTIFACT_CSP)
    if (req.url?.startsWith(`${base}src/sw.ts`)) res.setHeader('Service-Worker-Allowed', base)
    next()
  }
  return {
    name: 'anydot-dev-headers',
    configureServer: (server) => void server.middlewares.use(headers),
    configurePreviewServer: (server) => void server.middlewares.use(headers),
  }
}

export default defineConfig({
  base,
  // The web app ships with the desktop version it was built from.
  define: { __APP_VERSION__: JSON.stringify(desktop.version) },
  plugins: [react(), tailwindcss(), devHeaders()],
  resolve: {
    // The renderer lives in apps/desktop; keep one copy of React for both sides.
    dedupe: ['react', 'react-dom'],
  },
  // SQLite WASM finds its .wasm next to its own module; pre-bundling would move it.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { index: 'index.html', sw: 'src/sw.ts' },
      output: {
        // The service worker needs a fixed URL at the app root to control all of /app/.
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
})
