import { app, BrowserWindow, session } from 'electron'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Result-page scrapers, tried in order until one returns results. */
const ENGINES: { name: string; url: (q: string) => string; extract: string }[] = [
  {
    name: 'Bing',
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    extract: BING(),
  },
  {
    // www.bing.com serves an empty page in some regions (e.g. mainland China).
    name: 'Bing',
    url: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}`,
    extract: BING(),
  },
  {
    name: 'Google',
    url: (q) => `https://www.google.com/search?hl=en&q=${encodeURIComponent(q)}`,
    extract: `[...document.querySelectorAll('#search a:has(> h3)')].map((a) => {
      const box = a.closest('[data-hveid], .g, .MjjYud')
      return {
        title: a.querySelector('h3').innerText,
        url: a.href,
        snippet: box?.querySelector('.VwiC3b, [data-sncf], .IsZvec')?.innerText || '',
      }
    })`,
  },
]

function BING() {
  return `[...document.querySelectorAll('#b_results > li.b_algo')].map((li) => ({
    title: li.querySelector('h2')?.innerText || '',
    url: li.querySelector('h2 a')?.href || '',
    snippet: li.querySelector('.b_caption p, p')?.innerText || '',
  }))`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Web search by loading a search engine's result page in a hidden window,
 * like a person would. Works with any model or gateway and needs no API key.
 */
export class WebSearch {
  private win: BrowserWindow | null = null
  private queue: Promise<unknown> = Promise.resolve()

  search(query: string, limit = 8): Promise<SearchResult[]> {
    const run = this.queue.then(() => this.run(query, limit))
    this.queue = run.catch(() => {})
    return run
  }

  close() {
    this.win?.destroy()
    this.win = null
  }

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const ses = session.fromPartition('persist:aitech-search')
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setUserAgent(app.userAgentFallback.replace(/\s(aitech|Electron)\/\S+/g, ''))
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true },
    })
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.win = win
    return win
  }

  private async run(query: string, limit: number): Promise<SearchResult[]> {
    const wc = this.window().webContents
    const errors: string[] = []
    for (const engine of ENGINES) {
      try {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([
          wc.loadURL(engine.url(query)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out')), 15_000)
          }),
        ]).finally(() => clearTimeout(timer))
        // Result pages fill in a little after load.
        let results: SearchResult[] = []
        for (let i = 0; i < 6 && !results.length; i++) {
          await sleep(i ? 500 : 300)
          results = ((await wc.executeJavaScript(engine.extract)) as SearchResult[]).filter(
            (r) => r.title && /^https?:/.test(r.url),
          )
        }
        if (results.length)
          return results.slice(0, limit).map((r) => ({
            title: clean(r.title, 200),
            url: unwrapRedirect(r.url),
            snippet: clean(r.snippet, 300),
          }))
        errors.push(`${engine.name}: no results`)
      } catch (err) {
        errors.push(`${engine.name}: ${(err as Error).message}`)
      }
    }
    throw new Error(`Search failed (${errors.join('; ')})`)
  }
}

/** Bing wraps result links in a click tracker; the target is base64url in `u` ("a1" + data). */
export function unwrapRedirect(url: string): string {
  try {
    const u = new URL(url)
    const target = u.searchParams.get('u')
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname === '/ck/a' && target?.startsWith('a1')) {
      const decoded = Buffer.from(target.slice(2), 'base64url').toString('utf8')
      if (/^https?:\/\//.test(decoded)) return decoded
    }
  } catch {
    // not a URL we can unwrap
  }
  return url
}

const clean = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
