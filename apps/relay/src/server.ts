import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import {
  authMessage,
  deviceIdOf,
  fromB64url,
  MAX_FRAME_BYTES,
  normalizePairingCode,
  type PairingOffer,
  verify,
  type ClientFrame,
  type DeviceKind,
  type RelayInfo,
  type ServerFrame,
} from '@aitech/protocol'
import { WebSocketServer, type WebSocket } from 'ws'
import { AccessStore } from './access'
import { createAdmin, readJson } from './admin'
import { FeedbackStore } from './feedback'
import { admit, stillAdmitted, type Admission } from './auth'
import type { RelayConfig } from './config'
import { PushService } from './push'

export const VERSION = '0.1.0'

/** Typed-code pairing: how long an offer may live, and lookups allowed per IP. */
const MAX_OFFER_MS = 10 * 60_000
const LOOKUPS_PER_IP = 10
const LOOKUP_WINDOW = 60_000

interface Conn {
  ws: WebSocket
  ip: string
  deviceId: string | null
  publicKey: string | null
  kind: DeviceKind | null
  admission: Admission | null
  tokens: number
  lastRefill: number
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export interface RelayServer {
  url: string
  server: Server
  close: () => Promise<void>
  /** For tests and metrics. */
  online: () => number
  access: AccessStore
}

export async function startRelay(
  config: RelayConfig,
  opts: { fetch?: typeof fetch; log?: (...a: unknown[]) => void } = {},
): Promise<RelayServer> {
  const log = opts.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), ...a))
  let push: PushService | null = null
  try {
    push = new PushService(config.dataDir, config.vapidSubject)
  } catch (err) {
    log('web push disabled:', (err as Error).message)
  }

  const devices = new Map<string, Set<Conn>>()
  const perIp = new Map<string, number>()
  const access = new AccessStore(config.dataDir, {
    mode: config.auth,
    envToken: config.authToken,
    upstreams: config.allowedUpstreams,
    limits: { maxConnectionsPerIp: config.maxConnectionsPerIp, messageRate: config.messageRate },
  })

  const feedback = new FeedbackStore(config.dataDir)
  /** Pairing codes desktops registered, by normalized code. Memory only: they last minutes. */
  const offers = new Map<string, PairingOffer>()
  const lookups = new Map<string, number[]>()

  const loggedIn = () => [...devices.values()].flatMap((set) => [...set])
  const admin = createAdmin({
    access,
    feedback,
    log,
    stats: () => {
      const conns = loggedIn()
      const byToken: Record<string, number> = {}
      for (const c of conns) {
        const id = c.admission?.tokenId
        if (id) byToken[id] = (byToken[id] ?? 0) + 1
      }
      const count = (kind: DeviceKind) =>
        new Set(conns.filter((c) => c.kind === kind).map((c) => c.deviceId)).size
      return { desktops: count('desktop'), mobiles: count('mobile'), byToken }
    },
    enforce: () => {
      for (const c of loggedIn()) {
        if (c.admission && stillAdmitted(c.admission, access)) continue
        send(c.ws, {
          t: 'error',
          code: 'unauthorized',
          message: '中继的准入设置已更改，请重新验证',
        })
        c.ws.close(4403, 'not admitted')
      }
    },
  })

  const info = (): RelayInfo => ({
    name: 'aitech-relay',
    version: VERSION,
    auth: access.mode,
    vapidPublicKey: push?.publicKey,
    mobileUrl:
      config.mobileDir && config.publicUrl
        ? `${config.publicUrl.replace(/\/+$/, '')}/m/`
        : undefined,
  })

  const server = createServer((req, res) => void handleHttp(req, res))

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://relay')
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', '*')
      res.writeHead(204).end()
      return
    }
    if (url.pathname === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(info()))
      return
    }
    if (await admin(req, res, url, clientIp(req))) return
    if (url.pathname === '/feedback' && req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = await readJson(req)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '请求格式错误' }))
        return
      }
      const r = feedback.add(body, clientIp(req))
      res.writeHead('error' in r ? r.status : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify('error' in r ? { error: r.error } : { id: r.entry.id }))
      return
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
      return
    }
    if (config.mobileDir && (url.pathname === '/m' || url.pathname.startsWith('/m/'))) {
      await serveStatic(config.mobileDir, url.pathname.slice(2) || '/', res)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
  }

  async function serveStatic(root: string, path: string, res: ServerResponse) {
    const base = resolve(root)
    let file = normalize(join(base, decodeURIComponent(path)))
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end()
      return
    }
    let info = await stat(file).catch(() => null)
    if (info?.isDirectory()) {
      file = join(file, 'index.html')
      info = await stat(file).catch(() => null)
    }
    // SPA fallback: unknown paths get index.html.
    if (!info) {
      file = join(base, 'index.html')
      info = await stat(file).catch(() => null)
      if (!info) {
        res.writeHead(404).end('mobile app not built')
        return
      }
    }
    const ext = extname(file)
    const immutable = file.includes(`${sep}assets${sep}`)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(await readFile(file))
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const ip = clientIp(req)
    if ((perIp.get(ip) ?? 0) >= access.limits.maxConnectionsPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip))
  })

  function clientIp(req: IncomingMessage): string {
    // Behind nginx: trust the first X-Forwarded-For hop only from loopback.
    const remote = req.socket.remoteAddress ?? ''
    const fwd = req.headers['x-forwarded-for']
    if (fwd && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
      return String(fwd).split(',')[0]!.trim()
    }
    return remote
  }

  function send(ws: WebSocket, frame: ServerFrame) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  function onConnection(ws: WebSocket, ip: string) {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
    const conn: Conn = {
      ws,
      ip,
      deviceId: null,
      publicKey: null,
      kind: null,
      admission: null,
      tokens: access.limits.messageRate * 2,
      lastRefill: Date.now(),
    }
    const nonce = randomBytes(24).toString('base64url')
    send(ws, { t: 'challenge', nonce, info: info() })

    // Unauthenticated sockets must log in promptly.
    const loginTimer = setTimeout(() => {
      if (!conn.deviceId) ws.close(4401, 'login timeout')
    }, 15_000)

    let alive = true
    ws.on('pong', () => (alive = true))
    const ping = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, 30_000)

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4400, 'text frames only')
      // Token bucket per connection.
      const now = Date.now()
      const rate = access.limits.messageRate
      conn.tokens = Math.min(rate * 2, conn.tokens + ((now - conn.lastRefill) / 1000) * rate)
      conn.lastRefill = now
      if (conn.tokens < 1) {
        send(ws, { t: 'error', code: 'rate_limited', message: 'too many messages' })
        return
      }
      conn.tokens--

      let frame: ClientFrame
      try {
        frame = JSON.parse(data.toString()) as ClientFrame
      } catch {
        return send(ws, { t: 'error', code: 'bad_frame', message: 'invalid JSON' })
      }
      void onFrame(conn, frame, nonce).catch((err) => log('frame error', err))
    })

    ws.on('close', () => {
      clearTimeout(loginTimer)
      clearInterval(ping)
      const n = (perIp.get(ip) ?? 1) - 1
      if (n <= 0) perIp.delete(ip)
      else perIp.set(ip, n)
      if (conn.deviceId) {
        const set = devices.get(conn.deviceId)
        set?.delete(conn)
        if (set && !set.size) devices.delete(conn.deviceId)
      }
    })
  }

  async function onFrame(conn: Conn, f: ClientFrame, nonce: string) {
    const { ws } = conn
    if (f.t === 'ping') return send(ws, { t: 'pong' })

    if (f.t === 'hello') {
      if (conn.deviceId) return
      let key: Uint8Array
      try {
        key = fromB64url(f.publicKey)
      } catch {
        return ws.close(4400, 'bad key')
      }
      if (
        key.length !== 32 ||
        deviceIdOf(key) !== f.deviceId ||
        !verify(key, authMessage(nonce), f.signature)
      ) {
        send(ws, { t: 'error', code: 'unauthorized', message: '设备签名无效' })
        return ws.close(4401, 'bad signature')
      }
      const admission = await admit(access, f.auth, opts.fetch)
      if (typeof admission === 'string') {
        send(ws, { t: 'error', code: 'unauthorized', message: admission })
        return ws.close(4403, 'not admitted')
      }
      conn.admission = admission
      conn.deviceId = f.deviceId
      conn.publicKey = f.publicKey
      conn.kind = f.kind === 'desktop' ? 'desktop' : 'mobile'
      const set = devices.get(f.deviceId) ?? new Set()
      set.add(conn)
      devices.set(f.deviceId, set)
      return send(ws, { t: 'ready', deviceId: f.deviceId })
    }

    if (!conn.deviceId) {
      send(ws, { t: 'error', code: 'unauthorized', message: 'login first' })
      return
    }

    switch (f.t) {
      case 'send': {
        const targets = devices.get(f.to)
        if (!targets?.size)
          return send(ws, { t: 'error', id: f.id, code: 'offline', message: 'peer offline' })
        for (const t of targets)
          send(t.ws, {
            t: 'msg',
            from: conn.deviceId,
            fromKey: conn.publicKey!,
            payload: f.payload,
          })
        return send(ws, { t: 'ack', id: f.id })
      }
      case 'push': {
        if (!push)
          return send(ws, {
            t: 'error',
            id: f.id,
            code: 'push_unavailable',
            message: 'push disabled',
          })
        if (!push.hasSubscription(f.to))
          return send(ws, {
            t: 'error',
            id: f.id,
            code: 'no_subscription',
            message: 'no subscription',
          })
        // Web Push payload limit is ~4KB; senders keep these small.
        if (f.payload.length > 3000)
          return send(ws, {
            t: 'error',
            id: f.id,
            code: 'too_large',
            message: 'push payload too large',
          })
        const body = JSON.stringify({
          from: conn.deviceId,
          fromKey: conn.publicKey,
          payload: f.payload,
        })
        const ok = await push.send(f.to, body)
        return send(
          ws,
          ok
            ? { t: 'ack', id: f.id }
            : { t: 'error', id: f.id, code: 'offline', message: 'push failed' },
        )
      }
      case 'push.subscribe':
        push?.subscribe(conn.deviceId, f.subscription)
        return
      case 'presence': {
        const online: Record<string, boolean> = {}
        for (const id of (f.ids ?? []).slice(0, 100)) online[id] = !!devices.get(id)?.size
        return send(ws, { t: 'presence', id: f.id, online })
      }
      case 'pair.offer': {
        if (conn.kind !== 'desktop')
          return send(ws, { t: 'error', id: f.id, code: 'bad_frame', message: 'desktops only' })
        const code = normalizePairingCode(String(f.code ?? ''))
        if (code.length < 8)
          return send(ws, { t: 'error', id: f.id, code: 'bad_frame', message: 'code too short' })
        const now = Date.now()
        // One live code per desktop; drop expired ones while we're here.
        for (const [k, o] of offers)
          if (o.deviceId === conn.deviceId || o.expiresAt < now) offers.delete(k)
        offers.set(code, {
          deviceId: conn.deviceId,
          publicKey: conn.publicKey!,
          name: String(f.name ?? '').slice(0, 60),
          expiresAt: Math.min(Number(f.expiresAt) || 0, now + MAX_OFFER_MS),
        })
        return send(ws, { t: 'ack', id: f.id })
      }
      case 'pair.lookup': {
        const now = Date.now()
        const recent = (lookups.get(conn.ip) ?? []).filter((t) => t > now - LOOKUP_WINDOW)
        if (recent.length >= LOOKUPS_PER_IP)
          return send(ws, {
            t: 'error',
            id: f.id,
            code: 'rate_limited',
            message: '尝试次数过多，请一分钟后再试',
          })
        recent.push(now)
        lookups.set(conn.ip, recent)
        if (lookups.size > 10_000) lookups.clear()
        const offer = offers.get(normalizePairingCode(String(f.code ?? '')))
        if (!offer || offer.expiresAt < now)
          return send(ws, {
            t: 'error',
            id: f.id,
            code: 'not_found',
            message: '配对码不存在或已过期，请在电脑上重新生成',
          })
        return send(ws, { t: 'pair.found', id: f.id, offer })
      }
      default:
        return send(ws, { t: 'error', code: 'bad_frame', message: 'unknown frame' })
    }
  }

  await new Promise<void>((r) => server.listen(config.port, config.host, r))
  const addr = server.address() as AddressInfo
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host
  return {
    url: `http://${host}:${addr.port}`,
    server,
    online: () => devices.size,
    access,
    close: () =>
      new Promise((r) => {
        access.flush()
        for (const c of wss.clients) c.terminate()
        wss.close()
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
