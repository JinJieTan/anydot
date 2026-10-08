import {
  authMessage,
  b64url,
  deviceIdOf,
  fromB64url,
  open,
  randomId,
  seal,
  sharedKey,
  sign,
  type Identity,
} from './crypto'
import type {
  ClientAuth,
  ClientFrame,
  DeviceKind,
  PushSubscriptionJSON,
  RelayInfo,
  ServerFrame,
} from './frames'
import { wsUrl } from './frames'
import { ReplayGuard, type AppMessage, type Envelope } from './messages'

export type RelayStatus = 'connecting' | 'online' | 'offline' | 'unauthorized'

export interface IncomingMessage {
  from: string
  fromKey: Uint8Array
  body: AppMessage
}

export interface RelayClientOptions {
  url: string
  identity: Identity
  kind: DeviceKind
  auth?: ClientAuth
  onMessage: (msg: IncomingMessage) => void
  onStatus?: (status: RelayStatus, detail?: string) => void
  onInfo?: (info: RelayInfo) => void
  /** Injectable for tests / environments without a global WebSocket. */
  WebSocketImpl?: typeof WebSocket
}

/**
 * Connection to a relay, shared by desktop and phone. Handles login,
 * reconnects with backoff, heartbeats, and end-to-end encryption: callers only
 * deal with plain AppMessages and peer public keys.
 */
export class RelayClient {
  private ws: WebSocket | null = null
  private status: RelayStatus = 'offline'
  private closed = false
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private keys = new Map<string, Uint8Array>()
  private replay = new ReplayGuard()
  info: RelayInfo | null = null

  constructor(private readonly opts: RelayClientOptions) {}

  get state(): RelayStatus {
    return this.status
  }

  connect(): void {
    this.closed = false
    this.open()
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
    this.setStatus('offline')
  }

  private setStatus(s: RelayStatus, detail?: string) {
    if (this.status === s && !detail) return
    this.status = s
    this.opts.onStatus?.(s, detail)
  }

  private open() {
    const WS = this.opts.WebSocketImpl ?? WebSocket
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WS(wsUrl(this.opts.url))
    } catch (err) {
      this.setStatus('offline', (err as Error).message)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onmessage = (e) => this.onFrame(JSON.parse(String(e.data)) as ServerFrame)
    ws.onclose = (e) => {
      this.stopHeartbeat()
      for (const p of this.pending.values()) p.reject(new Error('relay disconnected'))
      this.pending.clear()
      if (this.ws !== ws) return
      this.ws = null
      if (this.status === 'unauthorized' || this.closed) return
      this.setStatus('offline', e.reason || undefined)
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose follows and handles reconnect.
    }
  }

  private scheduleReconnect() {
    if (this.closed) return
    const delay = Math.min(30_000, 1000 * 2 ** this.retry) * (0.8 + Math.random() * 0.4)
    this.retry++
    this.retryTimer = setTimeout(() => this.open(), delay)
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => this.raw({ t: 'ping' }), 25_000)
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private raw(frame: ClientFrame) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(frame))
  }

  private onFrame(f: ServerFrame) {
    switch (f.t) {
      case 'challenge': {
        this.info = f.info
        this.opts.onInfo?.(f.info)
        const id = this.opts.identity
        this.raw({
          t: 'hello',
          v: 1,
          deviceId: id.deviceId,
          publicKey: b64url(id.publicKey),
          signature: sign(id, authMessage(f.nonce)),
          kind: this.opts.kind,
          auth: this.opts.auth,
        })
        break
      }
      case 'ready':
        this.retry = 0
        this.setStatus('online')
        this.startHeartbeat()
        break
      case 'msg':
        this.onMsg(f.from, f.fromKey, f.payload)
        break
      case 'ack':
        this.pending.get(f.id)?.resolve(undefined)
        this.pending.delete(f.id)
        break
      case 'presence':
        this.pending.get(f.id)?.resolve(f.online)
        this.pending.delete(f.id)
        break
      case 'error':
        if (f.id && this.pending.has(f.id)) {
          this.pending.get(f.id)!.reject(Object.assign(new Error(f.message), { code: f.code }))
          this.pending.delete(f.id)
        } else if (f.code === 'unauthorized') {
          this.setStatus('unauthorized', f.message)
        }
        break
      case 'pong':
        break
    }
  }

  private keyFor(peerKey: Uint8Array): Uint8Array {
    const id = b64url(peerKey)
    let k = this.keys.get(id)
    if (!k) {
      k = sharedKey(this.opts.identity, peerKey)
      this.keys.set(id, k)
    }
    return k
  }

  private onMsg(from: string, fromKeyB64: string, payload: string) {
    let fromKey: Uint8Array
    try {
      fromKey = fromB64url(fromKeyB64)
      // The relay vouches for `from`, but check it matches the key anyway.
      if (deviceIdOf(fromKey) !== from) return
      const text = open(this.keyFor(fromKey), payload, `${from}>${this.opts.identity.deviceId}`)
      const env = JSON.parse(text) as Envelope
      if (!this.replay.accept(env)) return
      this.opts.onMessage({ from, fromKey, body: env.body })
    } catch {
      // Undecryptable or malformed: not for us, or tampered. Drop silently.
    }
  }

  private request<T>(frame: ClientFrame & { id: string }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.ws?.readyState !== 1 || this.status !== 'online') {
        reject(Object.assign(new Error('relay offline'), { code: 'relay_offline' }))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(frame.id)
        reject(new Error('relay timeout'))
      }, 15_000)
      this.pending.set(frame.id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.raw(frame)
    })
  }

  private envelope(peerKey: Uint8Array, body: AppMessage): { to: string; payload: string } {
    const to = deviceIdOf(peerKey)
    const env: Envelope = { v: 1, id: randomId(), ts: Date.now(), body }
    return {
      to,
      payload: seal(
        this.keyFor(peerKey),
        JSON.stringify(env),
        `${this.opts.identity.deviceId}>${to}`,
      ),
    }
  }

  /** Send an encrypted message. Rejects with code "offline" if the peer isn't connected. */
  send(peerKey: Uint8Array, body: AppMessage): Promise<void> {
    return this.request({ t: 'send', id: randomId(), ...this.envelope(peerKey, body) })
  }

  /** Wake a peer through Web Push. The payload stays end-to-end encrypted. */
  push(peerKey: Uint8Array, body: AppMessage): Promise<void> {
    return this.request({ t: 'push', id: randomId(), ...this.envelope(peerKey, body) })
  }

  presence(ids: string[]): Promise<Record<string, boolean>> {
    return this.request({ t: 'presence', id: randomId(), ids })
  }

  subscribePush(subscription: PushSubscriptionJSON): void {
    this.raw({ t: 'push.subscribe', subscription })
  }
}

export { fromB64url }
