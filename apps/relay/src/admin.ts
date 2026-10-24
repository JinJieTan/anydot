import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthMode } from '@aitech/protocol'
import { ENV_TOKEN_ID, type AccessStore } from './access'
import { ADMIN_PAGE } from './admin-page'
import type { RelayConfig } from './config'

export interface AdminStats {
  desktops: number
  mobiles: number
  /** Logged-in connections per access token id. */
  byToken: Record<string, number>
}

export interface AdminState {
  mode: AuthMode
  modes: AuthMode[]
  hasEnvToken: boolean
  tokens: {
    id: string
    name: string
    prefix: string
    createdAt: number
    lastUsedAt: number | null
    connections: number
  }[]
  online: { desktops: number; mobiles: number }
}

const MAX_FAILURES = 10
const FAILURE_WINDOW = 15 * 60_000

/**
 * The relay's admin page and API, enabled by ADMIN_TOKEN. It manages admission
 * only (open vs. token, and the tokens); devices still pair with each other.
 */
export function createAdmin(deps: {
  config: RelayConfig
  access: AccessStore
  stats: () => AdminStats
  /** Disconnect clients that are no longer admitted. */
  enforce: () => void
}) {
  const { config, access } = deps
  const failures = new Map<string, { n: number; until: number }>()
  const adminHash = config.adminToken
    ? createHash('sha256').update(config.adminToken).digest()
    : null

  const modes = (): AuthMode[] =>
    config.allowedUpstreams.length ? ['open', 'token', 'upstream'] : ['open', 'token']

  function state(): AdminState {
    const stats = deps.stats()
    return {
      mode: access.mode,
      modes: modes(),
      hasEnvToken: access.hasEnvToken,
      tokens: access.list().map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        connections: stats.byToken[t.id] ?? 0,
      })),
      online: { desktops: stats.desktops, mobiles: stats.mobiles },
    }
  }

  function authorized(req: IncomingMessage, ip: string): boolean | 'locked' {
    const f = failures.get(ip)
    if (f && f.until > Date.now() && f.n >= MAX_FAILURES) return 'locked'
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    const ok =
      !!m && !!adminHash && timingSafeEqual(createHash('sha256').update(m[1]!).digest(), adminHash)
    if (ok) failures.delete(ip)
    else {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + FAILURE_WINDOW }
      cur.n++
      failures.set(ip, cur)
      if (failures.size > 10_000) failures.clear()
    }
    return ok
  }

  /** Handles /admin and /admin/api/*; returns false for other paths. */
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ip: string,
  ): Promise<boolean> {
    const path = url.pathname
    if (path !== '/admin' && !path.startsWith('/admin/')) return false
    // Same-origin only: no CORS headers on anything admin.
    res.removeHeader('Access-Control-Allow-Origin')
    if (!adminHash) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('admin disabled (set ADMIN_TOKEN)')
      return true
    }
    if (!path.startsWith('/admin/api/')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      })
      res.end(ADMIN_PAGE)
      return true
    }

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
      return true
    }

    const auth = authorized(req, ip)
    if (auth === 'locked') return json(429, { error: '失败次数过多，请 15 分钟后再试' })
    if (!auth) return json(401, { error: '管理令牌不正确' })

    const route = `${req.method} ${path.slice('/admin/api'.length)}`
    if (route === 'GET /state') return json(200, state())

    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch {
      return json(400, { error: '请求格式错误' })
    }

    if (route === 'PUT /mode') {
      const mode = body.mode as AuthMode
      if (!modes().includes(mode)) return json(400, { error: '不支持的准入模式' })
      if (mode === 'token' && !access.hasEnvToken && !access.list().length)
        return json(400, { error: '请先创建至少一个访问令牌，否则所有设备都无法连接' })
      access.setMode(mode)
      deps.enforce()
      return json(200, state())
    }
    if (route === 'POST /tokens') {
      const { token, entry } = access.create(String(body.name ?? ''))
      return json(200, { token, id: entry.id, state: state() })
    }
    const del = /^DELETE \/tokens\/([\w-]+)$/.exec(route)
    if (del) {
      if (del[1] === ENV_TOKEN_ID)
        return json(400, { error: '环境变量里的令牌只能在服务器上修改 AUTH_TOKEN' })
      if (!access.revoke(del[1]!)) return json(404, { error: '令牌不存在' })
      deps.enforce()
      return json(200, state())
    }
    return json(404, { error: 'not found' })
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'DELETE') return {}
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 4096) throw new Error('too large')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const v = text ? (JSON.parse(text) as unknown) : {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
  return v as Record<string, unknown>
}
