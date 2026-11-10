/**
 * Preview anydot.app as deployed: the landing page (apps/site) at / and this
 * app's build (dist/) at /app/, with the headers nginx adds (see README.md).
 * Run `pnpm --filter @aitech/web build` first.
 */
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { ARTIFACT_CSP } from '../src/artifact-csp.ts'

const SITE = join(import.meta.dirname, '../../site')
const APP = join(import.meta.dirname, '../dist')
const PORT = Number(process.env.PORT ?? 5180)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  if (path === '/app') return void res.writeHead(301, { Location: '/app/' }).end()
  const inApp = path.startsWith('/app/')
  let rel = normalize(inApp ? path.slice('/app'.length) : path).replace(/^(\.\.[/\\])+/, '')
  if (rel.endsWith('/')) rel += 'index.html'
  const file = join(inApp ? APP : SITE, rel)
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file')
    const headers: Record<string, string> = {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    }
    if (path === '/app/artifact.html') headers['Content-Security-Policy'] = ARTIFACT_CSP
    if (path === '/app/sw.js') headers['Cache-Control'] = 'no-cache'
    res.writeHead(200, headers).end(await readFile(file))
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, () => console.log(`anydot.app preview: http://localhost:${PORT}/`))
