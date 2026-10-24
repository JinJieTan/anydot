import { hostname } from 'node:os'
import { base64ToBytes, bytesToBase64, newId, normalizeBaseUrl } from '@aitech/core'
import type { Store } from '@aitech/db'
import {
  b64url,
  createIdentity,
  fromB64url,
  infoUrl,
  pairingCode,
  pairingLink,
  RelayClient,
  type AppMessage,
  type ClientAuth,
  type Identity,
  type IncomingMessage,
  type RelayInfo,
  type RelayStatus,
} from '@aitech/protocol'
import {
  OFFICIAL_RELAY_URL,
  type ChatStreamEvent,
  type PairRequestDTO,
  type RemoteState,
  type RemoteStatusDTO,
} from '../shared/ipc'
import type { BlobStore } from './blobs'
import type { ChatService } from './chat-service'
import { decryptKey, encryptKey } from './secrets'

const PAIRING_TTL = 2 * 60_000
const ACTIVE_WINDOW = 3 * 60_000
const DELTA_FLUSH_MS = 120
const MAX_BLOB_BYTES = 8 * 1024 * 1024

interface RemoteSettings {
  enabled: boolean
  relayUrl: string | null
  /** Encrypted with safeStorage. */
  tokenRef: string | null
  providerId: string | null
}

const DEFAULTS: RemoteSettings = {
  enabled: false,
  relayUrl: null,
  tokenRef: null,
  providerId: null,
}

interface PendingPair {
  requestId: string
  from: string
  fromKey: Uint8Array
  name: string
  platform: string
}

/**
 * Pairs phones with this desktop and serves them over the relay.
 *
 * Trust is local: a phone is trusted only after the user confirms its pairing
 * request here, and every message is end-to-end encrypted to that phone's key.
 * The relay (ours or anyone's) only sees ciphertext and who is online.
 */
export class RemoteService {
  private identity: Identity
  private client: RelayClient | null = null
  private relayState: RelayStatus | 'error' = 'offline'
  private detail: string | undefined
  private info: RelayInfo | null = null
  private pairing: { link: string; code: string; expiresAt: number } | null = null
  private pendingPairs = new Map<string, PendingPair>()
  private active = new Map<string, number>()
  private online = new Set<string>()
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  private deltaBuf = new Map<string, Extract<ChatStreamEvent, { type: 'delta' }>>()
  private deltaTimer: ReturnType<typeof setTimeout> | null = null
  readonly deviceName = (hostname().replace(/\.local$/, '') || 'Desktop').slice(0, 40)

  constructor(
    private readonly store: Store,
    private readonly chat: ChatService,
    private readonly blobs: BlobStore,
    private readonly emitStatus: (s: RemoteStatusDTO) => void,
    private readonly emitPairRequest: (r: PairRequestDTO) => void,
  ) {
    this.identity = this.loadIdentity()
  }

  private loadIdentity(): Identity {
    const ref = this.store.getSetting<string | null>('remote.identity', null)
    const secret = ref ? decryptKey(ref) : null
    if (secret) return createIdentity(fromB64url(secret))
    const id = createIdentity()
    this.store.setSetting('remote.identity', encryptKey(b64url(id.secretKey)))
    return id
  }

  private get settings(): RemoteSettings {
    const s = {
      ...DEFAULTS,
      ...this.store.getSetting<Partial<RemoteSettings>>('remote.settings', {}),
    }
    // No relay of your own: use the official one.
    return { ...s, relayUrl: s.relayUrl || OFFICIAL_RELAY_URL }
  }

  private saveSettings(patch: Partial<RemoteSettings>) {
    this.store.setSetting('remote.settings', { ...this.settings, ...patch })
  }

  // ── status ─────────────────────────────────────────────────

  status(): RemoteStatusDTO {
    const s = this.settings
    const now = Date.now()
    if (this.pairing && this.pairing.expiresAt < now) this.pairing = null
    const state: RemoteState = !s.enabled || !s.relayUrl ? 'disabled' : this.relayState
    return {
      enabled: s.enabled,
      relayUrl: s.relayUrl,
      state,
      detail: this.detail,
      authMode: this.info?.auth,
      hasToken: !!s.tokenRef,
      providerId: s.providerId,
      deviceId: this.identity.deviceId,
      deviceName: this.deviceName,
      devices: this.store.listTrustedDevices().map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        platform: d.platform,
        pairedAt: d.pairedAt,
        lastSeen: d.lastSeen,
        online: this.online.has(d.deviceId),
      })),
      pairing: this.pairing,
      // Recently active and still connected: a phone that went away can't act anymore.
      activeDevices: [...this.active]
        .filter(([id, t]) => now - t < ACTIVE_WINDOW && this.online.has(id))
        .map(([id]) => id),
    }
  }

  private notify() {
    this.emitStatus(this.status())
  }

  // ── lifecycle ──────────────────────────────────────────────

  async configure(input: {
    enabled?: boolean
    relayUrl?: string | null
    token?: string | null
    providerId?: string | null
  }) {
    const patch: Partial<RemoteSettings> = {}
    if (input.relayUrl !== undefined) {
      if (input.relayUrl) {
        const u = new URL(input.relayUrl.trim())
        if (!/^(https?|wss?):$/.test(u.protocol))
          throw new Error('中继地址必须是 http(s):// 或 ws(s)://')
        patch.relayUrl = u.toString().replace(/\/+$/, '')
      } else patch.relayUrl = null
    }
    if (input.token !== undefined) patch.tokenRef = input.token ? encryptKey(input.token) : null
    if (input.providerId !== undefined) patch.providerId = input.providerId
    if (input.enabled !== undefined) patch.enabled = input.enabled
    this.saveSettings(patch)
    await this.restart()
    return this.status()
  }

  async restart() {
    this.stop()
    const s = this.settings
    if (!s.enabled || !s.relayUrl) return this.notify()
    this.relayState = 'connecting'
    this.detail = undefined
    this.notify()

    let info: RelayInfo
    try {
      const res = await fetch(infoUrl(s.relayUrl), { signal: AbortSignal.timeout(8000) })
      info = (await res.json()) as RelayInfo
      if (info.name !== 'aitech-relay') throw new Error('不是 AnyDot 中继服务')
    } catch (err) {
      this.relayState = 'error'
      this.detail = `无法访问中继：${(err as Error).message}`
      this.notify()
      // Retry later; the relay may just be restarting.
      setTimeout(() => this.settings.enabled && this.client === null && void this.restart(), 30_000)
      return
    }
    this.info = info

    let auth: ClientAuth | undefined
    if (info.auth === 'token') {
      const token = decryptKey(s.tokenRef)
      if (!token) return this.fail('unauthorized', '该中继需要访问令牌')
      auth = { token }
    } else if (info.auth === 'upstream') {
      const creds = this.upstreamCredentials(s.relayUrl, s.providerId)
      if (!creds)
        return this.fail('unauthorized', '该中继需要用服务商的 Base URL 和 Key 验证，请选择服务商')
      auth = creds
    }

    this.client = new RelayClient({
      url: s.relayUrl,
      identity: this.identity,
      kind: 'desktop',
      auth,
      onMessage: (m) => void this.onMessage(m),
      onStatus: (st, detail) => {
        this.relayState = st
        this.detail = detail
        if (st === 'online') void this.refreshPresence()
        this.notify()
      },
      onInfo: (i) => (this.info = i),
    })
    this.client.connect()
    this.presenceTimer = setInterval(() => void this.refreshPresence(), 30_000)
  }

  private fail(state: RemoteState, detail: string) {
    this.relayState = state as RelayStatus
    this.detail = detail
    this.notify()
  }

  stop() {
    if (this.presenceTimer) clearInterval(this.presenceTimer)
    this.presenceTimer = null
    this.client?.close()
    this.client = null
    this.online.clear()
    this.relayState = 'offline'
  }

  /** Pick provider credentials for an "upstream" relay: explicit choice, else same host. */
  private upstreamCredentials(relayUrl: string, providerId: string | null): ClientAuth | null {
    const providers = this.store.listProviders().filter((p) => p.enabled)
    const host = new URL(relayUrl).host
    const p =
      providers.find((x) => x.id === providerId) ??
      providers.find((x) => {
        try {
          return new URL(x.baseUrl).host === host
        } catch {
          return false
        }
      })
    const key = p && decryptKey(p.keyRef)
    return p && key ? { baseUrl: p.baseUrl, apiKey: key } : null
  }

  /** Find a relay next to a configured provider: {base}/ctl/info. */
  async detect(): Promise<{ relayUrl: string; auth: string } | null> {
    for (const p of this.store.listProviders()) {
      let origin: string
      try {
        origin = new URL(normalizeBaseUrl(p.baseUrl)).origin
      } catch {
        continue
      }
      for (const candidate of [`${origin}/ctl`, origin]) {
        try {
          const res = await fetch(infoUrl(candidate), { signal: AbortSignal.timeout(5000) })
          const info = (await res.json()) as RelayInfo
          if (info.name === 'aitech-relay') return { relayUrl: candidate, auth: info.auth }
        } catch {
          // not here
        }
      }
    }
    return null
  }

  private async refreshPresence() {
    const ids = this.store.listTrustedDevices().map((d) => d.deviceId)
    if (!this.client || this.client.state !== 'online' || !ids.length) return
    try {
      const online = await this.client.presence(ids)
      const before = [...this.online].sort().join()
      this.online = new Set(
        Object.entries(online)
          .filter(([, v]) => v)
          .map(([k]) => k),
      )
      if ([...this.online].sort().join() !== before) this.notify()
    } catch {
      // transient
    }
  }

  // ── pairing ────────────────────────────────────────────────

  createPairing() {
    const s = this.settings
    if (!s.enabled || !s.relayUrl || this.relayState !== 'online')
      throw new Error('请先启用并连上中继')
    const code = pairingCode()
    const expiresAt = Date.now() + PAIRING_TTL
    const appUrl = this.info?.mobileUrl ?? `${s.relayUrl}/m/`
    const link = pairingLink(appUrl, {
      v: 1,
      r: s.relayUrl,
      d: this.identity.deviceId,
      k: b64url(this.identity.publicKey),
      c: code,
      n: this.deviceName,
      e: expiresAt,
    })
    this.pairing = { link, code, expiresAt }
    this.notify()
    return this.pairing
  }

  cancelPairing() {
    this.pairing = null
    this.notify()
  }

  async respondPair(requestId: string, accept: boolean) {
    const req = this.pendingPairs.get(requestId)
    if (!req) throw new Error('配对请求已过期')
    this.pendingPairs.delete(requestId)
    if (accept) {
      this.store.trustDevice({
        deviceId: req.from,
        name: req.name.slice(0, 60) || '手机',
        platform: req.platform.slice(0, 30) || null,
        publicKey: b64url(req.fromKey),
      })
      // One phone per code.
      this.pairing = null
      this.active.set(req.from, Date.now())
      this.online.add(req.from)
      await this.sendTo(req.fromKey, { type: 'pair.accept', name: this.deviceName })
    } else {
      await this.sendTo(req.fromKey, { type: 'pair.reject', reason: '电脑上拒绝了配对' })
    }
    this.notify()
  }

  async revoke(deviceId: string) {
    const d = this.store.getTrustedDevice(deviceId)
    this.store.revokeDevice(deviceId)
    this.online.delete(deviceId)
    this.active.delete(deviceId)
    if (d) await this.sendTo(fromB64url(d.publicKey), { type: 'unpaired' })
    this.notify()
  }

  // ── messaging ──────────────────────────────────────────────

  private async sendTo(key: Uint8Array, body: AppMessage): Promise<boolean> {
    if (!this.client || this.client.state !== 'online') return false
    try {
      await this.client.send(key, body)
      return true
    } catch {
      return false
    }
  }

  private async onMessage({ from, fromKey, body }: IncomingMessage) {
    const trusted = this.store.getTrustedDevice(from)
    // Trust is bound to the key that paired, not just the id.
    const isTrusted = !!trusted && trusted.publicKey === b64url(fromKey)

    if (body.type === 'pair.request') {
      const p = this.pairing
      if (!p || p.expiresAt < Date.now() || body.code !== p.code) {
        await this.sendTo(fromKey, {
          type: 'pair.reject',
          reason: '配对码无效或已过期，请在电脑上重新生成二维码',
        })
        return
      }
      const requestId = newId()
      this.pendingPairs.set(requestId, {
        requestId,
        from,
        fromKey,
        name: String(body.name ?? ''),
        platform: String(body.platform ?? ''),
      })
      this.emitPairRequest({
        requestId,
        name: String(body.name || '手机'),
        platform: String(body.platform || ''),
      })
      return
    }

    if (!isTrusted) {
      await this.sendTo(fromKey, { type: 'unpaired' })
      return
    }

    this.active.set(from, Date.now())
    this.store.touchDevice(from)
    if (!this.online.has(from)) {
      this.online.add(from)
      this.notify()
    }

    if (body.type === 'rpc.req') {
      try {
        const result = await this.handleRpc(body.method, body.params)
        await this.sendTo(fromKey, { type: 'rpc.res', rid: body.rid, ok: true, result })
      } catch (err) {
        await this.sendTo(fromKey, {
          type: 'rpc.res',
          rid: body.rid,
          ok: false,
          error: (err as Error).message,
        })
      }
      this.notify()
    }
  }

  /** The remote API: an explicit allowlist, much narrower than the local IPC. */
  private async handleRpc(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>
    const str = (k: string) => {
      const v = p[k]
      if (typeof v !== 'string' || !v) throw new Error(`缺少参数 ${k}`)
      return v
    }
    switch (method) {
      case 'sync':
        return {
          desktop: { name: this.deviceName, platform: process.platform },
          projects: this.store
            .listProjects()
            .map((x) => ({ id: x.id, name: x.name, permissionMode: x.permissionMode })),
          conversations: this.store.listConversations({ limit: 100 }),
          models: this.store.listAvailableModels().filter((m) => m.capabilities.includes('chat')),
          running: this.chat.runningConversations(),
          approvals: this.chat.pendingApprovals(),
        }
      case 'conversation.get': {
        const id = str('id')
        const conversation = this.store.getConversation(id)
        if (!conversation) throw new Error('对话不存在')
        return { conversation, messages: this.store.listMessages(id) }
      }
      case 'conversation.create': {
        const projectId = typeof p.projectId === 'string' ? p.projectId : null
        const project = projectId ? this.store.getProject(projectId) : undefined
        if (projectId && !project) throw new Error('项目不存在')
        return this.store.createConversation({
          projectId: project?.id ?? null,
          modelId: project?.defaultModelId ?? null,
        })
      }
      case 'chat.send': {
        const conversationId = str('conversationId')
        const text = typeof p.text === 'string' ? p.text : ''
        const images = Array.isArray(p.images)
          ? (p.images as { data: string; mime: string; name: string }[])
          : []
        const attachments = []
        for (const img of images.slice(0, 6)) {
          if (!/^image\//.test(img.mime)) continue
          const data = base64ToBytes(img.data)
          if (data.byteLength > MAX_BLOB_BYTES) throw new Error('图片过大')
          attachments.push({
            blob: await this.blobs.put(data, img.mime),
            mime: img.mime,
            name: img.name || 'image',
          })
        }
        await this.chat.send(conversationId, text, attachments, 'remote')
        return true
      }
      case 'chat.stop':
        this.chat.stop(str('conversationId'))
        return true
      case 'chat.approve': {
        const decision = p.decision
        if (decision !== 'allow' && decision !== 'deny' && decision !== 'allow-always')
          throw new Error('无效的决定')
        const answers =
          p.answers && typeof p.answers === 'object' && !Array.isArray(p.answers)
            ? Object.fromEntries(
                Object.entries(p.answers as Record<string, unknown>).filter(
                  (e): e is [string, string] => typeof e[1] === 'string',
                ),
              )
            : undefined
        this.chat.approve(str('conversationId'), str('toolCallId'), decision, answers)
        return true
      }
      case 'blob.get': {
        const sha = str('sha256')
        const data = await this.blobs.read(sha)
        if (data.byteLength > MAX_BLOB_BYTES) throw new Error('文件过大')
        return { mime: this.blobs.mime(sha), data: bytesToBase64(data) }
      }
      default:
        throw new Error(`不支持的方法 ${method}`)
    }
  }

  // ── event fan-out ──────────────────────────────────────────

  /** Forward chat activity to paired phones; deltas are batched. */
  onChatEvent(e: ChatStreamEvent) {
    if (!this.client || this.client.state !== 'online') return
    const devices = this.store.listTrustedDevices()
    if (!devices.length) return

    if (e.type === 'delta') {
      const key = e.messageId
      const cur = this.deltaBuf.get(key)
      this.deltaBuf.set(key, {
        ...e,
        text: (cur?.text ?? '') + (e.text ?? '') || undefined,
        reasoning: (cur?.reasoning ?? '') + (e.reasoning ?? '') || undefined,
      })
      if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS)
      return
    }
    // Keep ordering: pending deltas go out before the next event.
    this.flushDeltas()
    void this.broadcast({ type: 'event', name: 'chat', data: e }, notification(e, this.deviceName))
  }

  private flushDeltas() {
    if (this.deltaTimer) clearTimeout(this.deltaTimer)
    this.deltaTimer = null
    const batch = [...this.deltaBuf.values()]
    this.deltaBuf.clear()
    for (const d of batch) void this.broadcast({ type: 'event', name: 'chat', data: d })
  }

  private async broadcast(body: AppMessage, push?: { title: string; body: string; tag: string }) {
    for (const d of this.store.listTrustedDevices()) {
      const key = fromB64url(d.publicKey)
      const delivered = await this.sendTo(key, body)
      if (!delivered && push && this.client && this.info?.vapidPublicKey) {
        // Phone not connected (app in background): wake it with an encrypted push.
        await this.client.push(key, { type: 'event', name: 'notify', data: push }).catch(() => {})
      }
    }
  }
}

/** What deserves a phone notification when the app isn't open. */
function notification(
  e: ChatStreamEvent,
  desktop: string,
): { title: string; body: string; tag: string } | undefined {
  if (e.type === 'approval') {
    return {
      title: `${desktop} 需要你确认`,
      body: e.approval.summary.slice(0, 120),
      tag: e.approval.conversationId,
    }
  }
  if (e.type === 'run' && !e.running) {
    return {
      title: e.error ? `${desktop} 任务出错` : `${desktop} 任务完成`,
      body: e.error?.slice(0, 120) ?? '点击查看结果',
      tag: e.conversationId,
    }
  }
  return undefined
}
