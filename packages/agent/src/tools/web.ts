import { truncateOutput } from '../shell'
import { str, type AgentTool } from './types'

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Crude but dependency-free HTML → text, good enough for docs pages. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|pre|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code =
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

export const webFetchTool: AgentTool<{ url: string }> = {
  kind: 'network',
  definition: {
    name: 'web_fetch',
    description:
      'Fetch a web page or API over HTTP(S) and return it as text (HTML is converted to plain text). ' +
      'To find pages, use web_search first.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL' } },
      required: ['url'],
    },
  },
  describe: (i) => `访问 ${i.url}`,
  async run(input, ctx) {
    const url = str(input.url, 'url')
    if (!/^https?:\/\//i.test(url))
      return { output: 'Only http(s) URLs are supported.', isError: true }
    const res = await fetch(url, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
      headers: {
        'User-Agent': 'aitech-agent/0.1',
        Accept: 'text/html,application/json,text/plain,*/*',
      },
      redirect: 'follow',
    })
    const type = res.headers.get('content-type') ?? ''
    if (!/text|json|xml|javascript/.test(type) && type) {
      return { output: `HTTP ${res.status}, content-type ${type} is not text.`, isError: !res.ok }
    }
    const body = await res.text()
    const text = type.includes('html') ? htmlToText(body) : body
    return {
      output: `HTTP ${res.status} ${res.url}\n\n${truncateOutput(text, 20_000)}`,
      isError: !res.ok,
    }
  },
}
