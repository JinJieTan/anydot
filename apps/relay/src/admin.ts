import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthMode } from '@aitech/protocol'
import { ENV_TOKEN_ID, type AccessStore, type Limits } from './access'
import { ADMIN_PAGE } from './admin-page'
import type { FeedbackStore } from './feedback'

export interface AdminStats {
  desktops: number
  mobiles: number
  /** Logged-in connections per access token id. */
  byToken: Record<string, number>
}

export interface AdminState {
  username: string
  mode: AuthMode
  hasEnvToken: boolean
  upstreams: string[]
  limits: Limits
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

const MODES: AuthMode[] = ['open', 'token', 'upstream']
const MAX_FAILURES = 10
const FAILURE_WINDOW = 15 * 60_000
const SESSION_TTL = 12 * 60 * 60_000
const SETUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * The relay's admin page and API. It manages admission only (who may
 * connect); devices still pair with each other.
 *
 * The first visit creates the admin account, guarded by a one-time setup code
 * printed to the server log, so whoever finds the page first can't claim it.
 */
export function createAdmin(deps: {
  access: AccessStore
  feedback: FeedbackStore
  stats: () => AdminStats
  /** Disconnect clients that are no longer admitted. */
  enforce: () => void
  log: (...a: unknown[]) => void
}) {
  const { access } = deps
  const failures = new Map<string, { n: number; until: number }>()
  const sessions = new Map<string, number>()

  let setupCode: string | null = null
  if (!access.hasAdmin) {
    setupCode = Array.from({ length: 8 }, () => SETUP_ALPHABET[randomInt(32)]).join('')
    deps.log(`no admin account yet: open /admin and use setup code ${setupCode}`)
  }

  function state(): AdminState {
    const stats = deps.stats()
    return {
      username: access.adminName ?? '',
      mode: access.mode,
      hasEnvToken: access.hasEnvToken,
      upstreams: access.upstreams,
      limits: access.limits,
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

  const locked = (ip: string) => {
    const f = failures.get(ip)
    return !!f && f.until > Date.now() && f.n >= MAX_FAILURES
  }
  const failed = (ip: string) => {
    const f = failures.get(ip)
    const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + FAILURE_WINDOW }
    cur.n++
    failures.set(ip, cur)
    if (failures.size > 10_000) failures.clear()
  }

  function newSession(): string {
    const now = Date.now()
    for (const [k, until] of sessions) if (until < now) sessions.delete(k)
    const id = randomBytes(32).toString('base64url')
    sessions.set(id, now + SESSION_TTL)
    return id
  }

  function session(req: IncomingMessage): string | null {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    const until = m ? sessions.get(m[1]!) : undefined
    return until && until > Date.now() ? m![1]! : null
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

    const route = `${req.method} ${path.slice('/admin/api'.length)}`
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch {
      return json(400, { error: '请求格式错误' })
    }
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '')

    // ── no session needed ──
    if (route === 'GET /status') return json(200, { setup: !access.hasAdmin })

    if (route === 'POST /setup' || route === 'POST /login') {
      if (locked(ip)) return json(429, { error: '失败次数过多，请 15 分钟后再试' })
      const username = str('username').trim()
      const password = str('password')
      if (route === 'POST /setup') {
        if (access.hasAdmin || !setupCode)
          return json(409, { error: '管理员账号已存在，请直接登录' })
        const code = Buffer.from(str('code').trim().toUpperCase())
        if (code.length !== setupCode.length || !timingSafeEqual(code, Buffer.from(setupCode))) {
          failed(ip)
          return json(403, { error: '设置码不正确，请查看中继的启动日志' })
        }
        const invalid = validateAccount(username, password)
        if (invalid) return json(400, { error: invalid })
        access.setAdmin(username, password)
        setupCode = null
        deps.log(`admin account "${username}" created`)
      } else if (!access.checkAdmin(username, password)) {
        failed(ip)
        return json(401, { error: '用户名或密码不正确' })
      }
      failures.delete(ip)
      return json(200, { session: newSession(), state: state() })
    }

    // ── session required ──
    const sid = session(req)
    if (!sid) return json(401, { error: '登录已过期，请重新登录' })

    if (route === 'GET /state') return json(200, state())
    if (route === 'POST /logout') {
      sessions.delete(sid)
      return json(200, {})
    }

    if (route === 'PUT /account') {
      if (!access.checkAdmin(access.adminName ?? '', str('current')))
        return json(403, { error: '当前密码不正确' })
      const username = str('username').trim() || access.adminName!
      const invalid = validateAccount(username, str('password'))
      if (invalid) return json(400, { error: invalid })
      access.setAdmin(username, str('password'))
      // Everyone else has to log in again with the new password.
      sessions.clear()
      return json(200, { session: newSession(), state: state() })
    }

    if (route === 'PUT /mode') {
      const mode = body.mode as AuthMode
      if (!MODES.includes(mode)) return json(400, { error: '不支持的准入模式' })
      if (mode === 'token' && !access.hasEnvToken && !access.list().length)
        return json(400, { error: '请先创建至少一个访问令牌，否则所有设备都无法连接' })
      if (mode === 'upstream' && !access.upstreams.length)
        return json(400, { error: '请先添加至少一个允许的服务商地址' })
      access.setMode(mode)
      deps.enforce()
      return json(200, state())
    }

    if (route === 'PUT /upstreams') {
      const list = Array.isArray(body.upstreams) ? body.upstreams.map(String) : []
      if (access.mode === 'upstream' && !list.some((u) => u.trim()))
        return json(400, { error: '“仅限服务商用户”模式下至少要保留一个服务商' })
      try {
        access.setUpstreams(list.slice(0, 50))
      } catch (err) {
        return json(400, { error: `地址无效：${(err as Error).message}` })
      }
      deps.enforce()
      return json(200, state())
    }

    if (route === 'PUT /limits') {
      const patch: Partial<Limits> = {}
      for (const k of ['maxConnectionsPerIp', 'messageRate'] as const) {
        if (body[k] === undefined) continue
        const n = Number(body[k])
        if (!Number.isInteger(n) || n < 1 || n > 10_000)
          return json(400, { error: '限制必须是 1 到 10000 之间的整数' })
        patch[k] = n
      }
      access.setLimits(patch)
      return json(200, state())
    }

    if (route === 'GET /feedback') return json(200, { items: deps.feedback.list() })
    const delFeedback = /^DELETE \/feedback\/([\w-]+)$/.exec(route)
    if (delFeedback) {
      if (!deps.feedback.remove(delFeedback[1]!)) return json(404, { error: '反馈不存在' })
      return json(200, { items: deps.feedback.list() })
    }

    if (route === 'POST /tokens') {
      const { token, entry } = access.create(str('name'))
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

function validateAccount(username: string, password: string): string | null {
  if (!/^[\w.@-]{3,40}$/.test(username))
    return '用户名需要 3 到 40 个字符，只能包含字母、数字和 _ . @ -'
  if (password.length < 8) return '密码至少 8 位'
  if (password.length > 200) return '密码太长'
  return null
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'DELETE') return {}
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 16_384) throw new Error('too large')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const v = text ? (JSON.parse(text) as unknown) : {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
  return v as Record<string, unknown>
}
