import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { BrowserCommand, BrowserReply } from '@aitech/agent'
import type { ChromeExtStatus } from '../shared/ipc'
import { formatSnapshot, type PageSnapshot } from './page-helpers'

/** The extension tries these in order, so the app takes the first free one. */
export const CHROME_EXT_PORTS = [18741, 18742, 18743]
const PATH = '/aitech'
const HELLO_TIMEOUT = 5_000
const PING_EVERY = 20_000
const EXEC_TIMEOUT = 90_000

/** Chrome derives an extension's ID from the public key in its manifest. */
export function extensionIdFromKey(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

interface ExtReply {
  text?: string
  snapshot?: PageSnapshot
  image?: { data: string; mime: string }
}

type ExtMessage =
  | { type: 'hello'; version?: string; userAgent?: string }
  | { type: 'pong' }
  | { type: 'result'; id: number; result: ExtReply }
  | { type: 'error'; id: number; error: string }

interface Pending {
  resolve: (r: BrowserReply) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Local WebSocket server the aitech Chrome extension connects to. Only the
 * extension's own origin is accepted, so web pages can't talk to it.
 */
export class ChromeBridge {
  private server: WebSocketServer | null = null
  private port: number | null = null
  private sock: WebSocket | null = null
  private ext: { version: string | null; userAgent: string | null } | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private ping: NodeJS.Timeout | null = null
  private starting: Promise<void> | null = null

  constructor(
    private readonly opts: {
      allowedIds: string[]
      appVersion: string
      /** The version of the extension files this app ships. */
      extensionVersion: string
      ports?: number[]
      onStatus?: (s: ChromeExtStatus) => void
    },
  ) {}

  status(): ChromeExtStatus {
    return {
      listening: !!this.server,
      port: this.port,
      connected: !!this.ext,
      extensionVersion: this.ext?.version ?? null,
      userAgent: this.ext?.userAgent ?? null,
      expectedVersion: this.opts.extensionVersion,
    }
  }

  /** Listen only while the user has chosen the Chrome backend. */
  async setEnabled(on: boolean): Promise<void> {
    if (on) return this.start()
    this.stop()
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve()
    this.starting ??= this.listen().finally(() => {
      this.starting = null
      this.changed()
    })
    return this.starting
  }

  private async listen() {
    const ports = this.opts.ports ?? CHROME_EXT_PORTS
    for (const port of ports) {
      const server = await new Promise<WebSocketServer | null>((resolve) => {
        const s = new WebSocketServer({
          host: '127.0.0.1',
          port,
          path: PATH,
          maxPayload: 32 * 1024 * 1024,
          verifyClient: ({ req }: { req: IncomingMessage }) => this.allowed(req, port),
        })
        s.once('listening', () => resolve(s))
        s.once('error', () => {
          s.close()
          resolve(null)
        })
      })
      if (!server) continue
      server.on('connection', (sock) => this.accept(sock))
      this.server = server
      this.port = port
      return
    }
    throw new Error(`本机端口 ${ports.join('/')} 都被占用，Chrome 插件无法连接`)
  }

  private allowed(req: IncomingMessage, port: number): boolean {
    const origin = req.headers.origin ?? ''
    const host = req.headers.host ?? ''
    return (
      this.opts.allowedIds.some((id) => origin === `chrome-extension://${id}`) &&
      (host === `127.0.0.1:${port}` || host === `localhost:${port}`)
    )
  }

  private accept(sock: WebSocket) {
    const hello = setTimeout(() => sock.close(4001, 'no hello'), HELLO_TIMEOUT)
    let alive = true
    sock.on('message', (data) => {
      let msg: ExtMessage
      try {
        msg = JSON.parse(data.toString()) as ExtMessage
      } catch {
        return
      }
      alive = true
      if (msg.type === 'hello') {
        clearTimeout(hello)
        // A newer connection (e.g. a reloaded extension) replaces the old one.
        if (this.sock && this.sock !== sock) this.sock.close(4000, 'replaced')
        this.sock = sock
        this.ext = { version: msg.version ?? null, userAgent: msg.userAgent ?? null }
        sock.send(
          JSON.stringify({
            type: 'welcome',
            app: this.opts.appVersion,
            extensionVersion: this.opts.extensionVersion,
          }),
        )
        this.startPing(sock, () => {
          if (!alive) return sock.terminate()
          alive = false
          sock.send(JSON.stringify({ type: 'ping' }))
        })
        this.changed()
      } else if (msg.type === 'result' || msg.type === 'error') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.type === 'error') p.reject(new Error(msg.error))
        else p.resolve(toReply(msg.result))
      }
    })
    sock.on('close', () => {
      clearTimeout(hello)
      if (this.sock !== sock) return
      this.sock = null
      this.ext = null
      if (this.ping) clearInterval(this.ping)
      this.ping = null
      this.failAll('The Chrome extension disconnected.')
      this.changed()
    })
    sock.on('error', () => sock.terminate())
  }

  private startPing(sock: WebSocket, tick: () => void) {
    if (this.ping) clearInterval(this.ping)
    this.ping = setInterval(() => {
      if (this.sock === sock) tick()
    }, PING_EVERY)
  }

  exec(cmd: BrowserCommand, timeoutMs = EXEC_TIMEOUT): Promise<BrowserReply> {
    const sock = this.sock
    if (!sock || !this.ext) {
      return Promise.reject(
        new Error(
          'The aitech Chrome extension is not connected. Ask the user to open Chrome and make sure the extension is installed and enabled (aitech Settings → Automation), or to switch back to the built-in browser.',
        ),
      )
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome did not answer within ${timeoutMs / 1000}s.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      sock.send(JSON.stringify({ type: 'exec', id, cmd }))
    })
  }

  stop(): void {
    this.failAll('The Chrome extension bridge was stopped.')
    if (this.ping) clearInterval(this.ping)
    this.ping = null
    for (const client of this.server?.clients ?? []) client.terminate()
    this.server?.close()
    const was = !!this.server
    this.server = null
    this.port = null
    this.sock = null
    this.ext = null
    if (was) this.changed()
  }

  private failAll(reason: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private changed() {
    this.opts.onStatus?.(this.status())
  }
}

function toReply(r: ExtReply): BrowserReply {
  return {
    text: r.snapshot ? formatSnapshot(r.snapshot, r.text ?? '') : (r.text ?? ''),
    image: r.image,
  }
}
