import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * The web app's built-in "AnyDot 默认" provider: the browser calls
 * /llm/v1/* here with no key, and the relay forwards to the upstream the
 * admin configured, adding the upstream key. The key never leaves the server.
 */
export interface DefaultLlmConfig {
  enabled: boolean
  /** Normalized, ends in /v1. */
  baseUrl: string
  apiKey: string
  /** Model ids users may call; empty = any. */
  models: string[]
  /** Generation requests (POST) per IP per minute. */
  perMinute: number
  /** Generation requests per IP per day (server local date). */
  perDay: number
  /** Also serve requests that don't come from the web app's pages (desktop app, scripts). */
  allowDesktop: boolean
}

export interface DefaultLlmState extends Omit<DefaultLlmConfig, 'apiKey'> {
  hasKey: boolean
  keyHint: string | null
  today: { requests: number; ips: number; rejected: number }
}

const DEFAULTS: DefaultLlmConfig = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  models: [],
  perMinute: 10,
  perDay: 200,
  allowDesktop: false,
}

/** Paths under /v1 the web app uses; anything else is refused. */
const ALLOWED = [
  /^\/models$/,
  /^\/chat\/completions$/,
  /^\/responses$/,
  /^\/messages$/,
  /^\/images\/(generations|edits)$/,
  /^\/videos$/,
  /^\/videos\/[\w.-]+(\/content)?$/,
]
/** Request headers passed through to the upstream. Auth is replaced. */
const PASS_REQUEST = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta']
/** Response headers passed back. Encoding/length dropped: fetch already decoded the body. */
const PASS_RESPONSE = ['content-type', 'content-disposition', 'retry-after']
const MAX_BODY = 30 * 1024 * 1024
/** Polling (GET /videos/{id}, /models) per IP per minute; not counted against perDay. */
const GET_PER_MINUTE = 120

export function normalizeLlmBaseUrl(input: string): string {
  const url = new URL(input.trim())
  if (!/^https?:$/.test(url.protocol)) throw new Error('必须是 http(s) 地址')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

const keyHint = (k: string) =>
  !k ? null : k.length <= 10 ? '••••' : `${k.slice(0, 3)}…${k.slice(-4)}`
const localDay = () => new Date().toLocaleDateString('sv')

export class DefaultLlm {
  private config: DefaultLlmConfig
  private readonly file: string
  private minute = new Map<string, number[]>()
  private getMinute = new Map<string, number[]>()
  private day = { date: localDay(), perIp: new Map<string, number>(), requests: 0, rejected: 0 }

  constructor(
    dataDir: string,
    private readonly opts: {
      fetch?: typeof fetch
      log?: (...a: unknown[]) => void
      /** Origins of the web app (e.g. https://anydot.app); localhost is always one. */
      webOrigins?: string[]
    } = {},
  ) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'default-llm.json')
    const saved = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DefaultLlmConfig>)
      : {}
    this.config = { ...DEFAULTS, ...saved }
  }

  state(): DefaultLlmState {
    this.rollDay()
    const { apiKey, ...rest } = this.config
    return {
      ...rest,
      models: [...rest.models],
      hasKey: !!apiKey,
      keyHint: keyHint(apiKey),
      today: { requests: this.day.requests, ips: this.day.perIp.size, rejected: this.day.rejected },
    }
  }

  /** Throws with a user-facing message on invalid input. An empty apiKey keeps the current one. */
  update(patch: Record<string, unknown>) {
    const next = { ...this.config }
    if (patch.baseUrl !== undefined) {
      const s = String(patch.baseUrl).trim()
      try {
        next.baseUrl = s ? normalizeLlmBaseUrl(s) : ''
      } catch (err) {
        throw new Error(`地址无效：${(err as Error).message}`, { cause: err })
      }
    }
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim()
    if (patch.models !== undefined) {
      const list = Array.isArray(patch.models) ? patch.models : String(patch.models).split(/[\s,]+/)
      next.models = [...new Set(list.map((m) => String(m).trim()).filter(Boolean))].slice(0, 200)
    }
    for (const k of ['perMinute', 'perDay'] as const) {
      if (patch[k] === undefined) continue
      const n = Number(patch[k])
      if (!Number.isInteger(n) || n < 1 || n > 1_000_000)
        throw new Error('次数限制必须是 1 到 1000000 之间的整数')
      next[k] = n
    }
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled
    if (patch.allowDesktop !== undefined) next.allowDesktop = !!patch.allowDesktop
    if (next.enabled && (!next.baseUrl || !next.apiKey))
      throw new Error('启用前请先填写服务商地址和 Key')
    this.config = next
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private rollDay() {
    const today = localDay()
    if (this.day.date !== today)
      this.day = { date: today, perIp: new Map(), requests: 0, rejected: 0 }
  }

  /**
   * Whether the request comes from the web app's pages, by the headers a
   * browser sets itself. Anything else (the desktop app, scripts) counts as
   * desktop. Not a security boundary: a script can send these headers too.
   */
  private fromWeb(req: IncomingMessage): boolean {
    if (req.headers['sec-fetch-site'] === 'same-origin') return true
    const allowed = (o: string | undefined) => {
      if (!o) return false
      try {
        const u = new URL(o)
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
        return (this.opts.webOrigins ?? []).includes(u.origin)
      } catch {
        return false
      }
    }
    const referer = req.headers.referer
    return allowed(req.headers.origin) || allowed(referer)
  }

  /** Records the request if allowed; returns an error message otherwise. */
  private admit(ip: string, generation: boolean): string | null {
    const now = Date.now()
    const window = generation ? this.minute : this.getMinute
    const limit = generation ? this.config.perMinute : GET_PER_MINUTE
    const times = (window.get(ip) ?? []).filter((t) => t > now - 60_000)
    if (window.size > 50_000) window.clear()
    if (times.length >= limit) return '请求太频繁，请稍后再试'
    if (generation) {
      this.rollDay()
      const used = this.day.perIp.get(ip) ?? 0
      if (used >= this.config.perDay)
        return '今天的免费额度已用完，可以在设置 → 服务商里添加自己的 Key 继续使用'
      this.day.perIp.set(ip, used + 1)
      this.day.requests++
    }
    times.push(now)
    window.set(ip, times)
    return null
  }

  /** Handles /llm/v1/*; returns false for other paths. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<boolean> {
    const prefix = '/llm/v1'
    if (url.pathname !== '/llm' && !url.pathname.startsWith('/llm/')) return false
    const fail = (status: number, message: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      // OpenAI-style error body, which the SDKs turn into a readable message.
      res.end(JSON.stringify({ error: { message, type: 'anydot_default', code: status } }))
      return true
    }
    const c = this.config
    if (!c.enabled || !c.baseUrl || !c.apiKey)
      return fail(503, '默认服务暂未开放，请添加自己的服务商')
    if (!c.allowDesktop && !this.fromWeb(req))
      return fail(403, '默认服务目前只在网页版 anydot.app/app 开放，请在设置里添加自己的服务商')
    const sub = url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : ''
    if (!ALLOWED.some((r) => r.test(sub))) return fail(404, 'not found')
    if (req.method !== 'GET' && req.method !== 'POST') return fail(405, 'method not allowed')

    const generation = req.method === 'POST'
    let body: Buffer | undefined
    if (generation) {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_BODY) return fail(413, '请求内容过大')
        chunks.push(chunk as Buffer)
      }
      body = Buffer.concat(chunks)
      const model = modelOf(body, req.headers['content-type'] ?? '')
      if (c.models.length && (!model || !c.models.includes(model)))
        return fail(403, `默认服务不提供模型 ${model ?? '(未指定)'}，可用：${c.models.join('、')}`)
    }
    const denied = this.admit(ip, generation)
    if (denied) {
      this.day.rejected++
      return fail(429, denied)
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${c.apiKey}` }
    for (const h of PASS_REQUEST) {
      const v = req.headers[h]
      if (typeof v === 'string') headers[h] = v
    }
    if (req.headers['x-api-key']) headers['x-api-key'] = c.apiKey

    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })
    let upstream: Response
    try {
      upstream = await (this.opts.fetch ?? fetch)(`${c.baseUrl}${sub}${url.search}`, {
        method: req.method,
        headers,
        body: body && new Uint8Array(body),
        signal: abort.signal,
      })
    } catch (err) {
      if (abort.signal.aborted) return true
      this.opts.log?.('default llm upstream error:', (err as Error).message)
      return fail(502, '默认服务暂时连不上，请稍后再试')
    }

    const out: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
    for (const h of PASS_RESPONSE) {
      const v = upstream.headers.get(h)
      if (v) out[h] = v
    }
    if (sub === '/models' && upstream.ok && c.models.length) {
      const list = (await upstream.json().catch(() => null)) as { data?: { id?: string }[] } | null
      const data = (list?.data ?? []).filter((m) => m.id && c.models.includes(m.id))
      res.writeHead(200, { ...out, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...list, object: 'list', data }))
      return true
    }
    res.writeHead(upstream.status, out)
    if (!upstream.body) {
      res.end()
      return true
    }
    try {
      await pipeline(Readable.fromWeb(upstream.body as never), res)
    } catch {
      // Client went away or upstream broke mid-stream; nothing left to send.
    }
    return true
  }
}

/** The `model` of a JSON or multipart request body, if any. */
export function modelOf(body: Buffer, contentType: string): string | null {
  if (contentType.includes('application/json')) {
    try {
      const v = JSON.parse(body.toString('utf8')) as { model?: unknown }
      return typeof v.model === 'string' ? v.model : null
    } catch {
      return null
    }
  }
  if (contentType.includes('multipart/form-data')) {
    const m = /name="model"\r\n(?:[^\r\n]*\r\n)*\r\n([^\r\n]*)\r\n/.exec(body.toString('latin1'))
    return m ? Buffer.from(m[1]!, 'latin1').toString('utf8') : null
  }
  return null
}
