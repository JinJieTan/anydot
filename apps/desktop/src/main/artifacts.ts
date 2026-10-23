import { createHash } from 'node:crypto'
import { protocol } from 'electron'

/** Model-generated pages for the artifact panel, served as aitech-artifact://page/<id>. */
export const ARTIFACT_SCHEME = 'aitech-artifact'

/**
 * Artifacts run in a sandboxed iframe (opaque origin, no access to the app)
 * with their own CSP: inline scripts and https libraries/images are allowed,
 * but no network requests (no fetch / XHR / WebSocket).
 */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  "connect-src 'none'",
].join('; ')

const MAX_PAGES = 100

export class ArtifactServer {
  private pages = new Map<string, string>()

  /** Store a page; returns its URL. Same content, same URL. */
  put(html: string): string {
    const id = createHash('sha256').update(html).digest('hex').slice(0, 24)
    this.pages.delete(id)
    this.pages.set(id, html)
    // Oldest first: drop beyond the cap.
    for (const key of this.pages.keys()) {
      if (this.pages.size <= MAX_PAGES) break
      this.pages.delete(key)
    }
    return `${ARTIFACT_SCHEME}://page/${id}`
  }

  register(): void {
    protocol.handle(ARTIFACT_SCHEME, (req) => {
      const id = new URL(req.url).pathname.replace(/^\//, '')
      const html = this.pages.get(id)
      if (html === undefined) return new Response('not found', { status: 404 })
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': CSP,
          'Cache-Control': 'no-store',
        },
      })
    })
  }
}
