import {
  fromB64url,
  infoUrl,
  randomId,
  RelayClient,
  type AppMessage,
  type ClientAuth,
  type Identity,
  type PairingPayload,
  type RelayInfo,
  type RelayStatus,
} from '@aitech/protocol'
import type { PairedDesktop } from './storage'

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface RemoteEvent {
  desktopId: string
  name: string
  data: unknown
}

/**
 * The phone side of remote control: one relay connection per relay URL,
 * request/response RPC to paired desktops, and their live events.
 */
export class RemoteHub {
  private clients = new Map<string, RelayClient>()
  private pending = new Map<string, Pending>()
  private pairWaiters = new Map<string, (body: AppMessage) => void>()
  status = new Map<string, RelayStatus>()
  info = new Map<string, RelayInfo>()

  constructor(
    private readonly identity: Identity,
    private auth: (info: RelayInfo | null) => ClientAuth | undefined,
    private readonly onEvent: (e: RemoteEvent) => void,
    private readonly onStatus: () => void,
    private readonly onUnpaired: (desktopId: string) => void,
  ) {}

  get deviceId() {
    return this.identity.deviceId
  }

  async connect(relayUrl: string): Promise<RelayClient> {
    let client = this.clients.get(relayUrl)
    if (client) return client
    // Learn the relay's auth mode first so we can log in right away.
    let info: RelayInfo | null = null
    try {
      info = (await (await fetch(infoUrl(relayUrl))).json()) as RelayInfo
      this.info.set(relayUrl, info)
    } catch {
      // The client retries on its own; auth may be missing until then.
    }
    client = new RelayClient({
      url: relayUrl,
      identity: this.identity,
      kind: 'mobile',
      auth: this.auth(info),
      onMessage: (m) => this.onMessage(m.from, m.body),
      onStatus: (s) => {
        this.status.set(relayUrl, s)
        this.onStatus()
      },
      onInfo: (i) => this.info.set(relayUrl, i),
    })
    this.clients.set(relayUrl, client)
    client.connect()
    return client
  }

  /** Re-login everywhere, e.g. after changing the token or key. */
  reconnectAll() {
    const urls = [...this.clients.keys()]
    for (const c of this.clients.values()) c.close()
    this.clients.clear()
    for (const u of urls) void this.connect(u)
  }

  closeAll() {
    for (const c of this.clients.values()) c.close()
    this.clients.clear()
  }

  private onMessage(from: string, body: AppMessage) {
    switch (body.type) {
      case 'rpc.res': {
        const p = this.pending.get(body.rid)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(body.rid)
        if (body.ok) p.resolve(body.result)
        else p.reject(new Error(body.error))
        return
      }
      case 'event':
        this.onEvent({ desktopId: from, name: body.name, data: body.data })
        return
      case 'pair.accept':
      case 'pair.reject':
        this.pairWaiters.get(from)?.(body)
        return
      case 'unpaired':
        this.onUnpaired(from)
        return
    }
  }

  private async ready(relayUrl: string): Promise<RelayClient> {
    const client = await this.connect(relayUrl)
    const start = Date.now()
    while (client.state !== 'online') {
      if (client.state === 'unauthorized')
        throw new Error('中继拒绝了连接，请在设置中检查访问令牌或 Key')
      if (Date.now() - start > 10_000) throw new Error('连接中继超时')
      await new Promise((r) => setTimeout(r, 100))
    }
    return client
  }

  async rpc<T = unknown>(
    desktop: PairedDesktop,
    method: string,
    params?: unknown,
    timeoutMs = 20_000,
  ): Promise<T> {
    const client = await this.ready(desktop.relayUrl)
    const rid = randomId()
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new Error('电脑没有响应'))
      }, timeoutMs)
      this.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer })
    })
    try {
      await client.send(fromB64url(desktop.publicKey), { type: 'rpc.req', rid, method, params })
    } catch (err) {
      const p = this.pending.get(rid)
      if (p) clearTimeout(p.timer)
      this.pending.delete(rid)
      throw (err as { code?: string }).code === 'offline' ? new Error('电脑不在线') : err
    }
    return result
  }

  async presence(relayUrl: string, ids: string[]): Promise<Record<string, boolean>> {
    const client = await this.ready(relayUrl)
    return client.presence(ids)
  }

  /** Send a pairing request and wait for the user to confirm on the desktop. */
  async pair(p: PairingPayload, deviceName: string, platform: string): Promise<PairedDesktop> {
    if (p.e && p.e < Date.now()) throw new Error('二维码已过期，请在电脑上重新生成')
    const client = await this.ready(p.r)
    const answer = new Promise<AppMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pairWaiters.delete(p.d)
        reject(new Error('等待电脑确认超时'))
      }, 3 * 60_000)
      this.pairWaiters.set(p.d, (body) => {
        clearTimeout(timer)
        this.pairWaiters.delete(p.d)
        resolve(body)
      })
    })
    try {
      await client.send(fromB64url(p.k), {
        type: 'pair.request',
        code: p.c,
        name: deviceName,
        platform,
      })
    } catch (err) {
      this.pairWaiters.delete(p.d)
      throw (err as { code?: string }).code === 'offline'
        ? new Error('电脑不在线，请确认电脑上的 aitech 已打开')
        : err
    }
    const body = await answer
    if (body.type === 'pair.reject') throw new Error(body.reason)
    return {
      deviceId: p.d,
      publicKey: p.k,
      name: body.type === 'pair.accept' ? body.name : p.n,
      relayUrl: p.r,
      pairedAt: Date.now(),
    }
  }

  async subscribePush(relayUrl: string, sub: PushSubscriptionJSON) {
    const client = await this.ready(relayUrl)
    client.subscribePush(sub as never)
  }
}
