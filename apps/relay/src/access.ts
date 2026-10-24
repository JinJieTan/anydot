import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthMode } from '@aitech/protocol'
import { normalizeUpstream } from './auth'

/** A named access token. Only its hash is kept; the token is shown once on creation. */
export interface AccessToken {
  id: string
  name: string
  /** First characters of the token, so the admin can tell them apart. */
  prefix: string
  hash: string
  createdAt: number
  lastUsedAt: number | null
}

export interface Limits {
  maxConnectionsPerIp: number
  /** Messages per second per connection (burst = 2×). */
  messageRate: number
}

interface AdminAccount {
  username: string
  /** scrypt, hex */
  salt: string
  hash: string
}

/**
 * Settings changed from the admin page. Each one, once set, wins over the
 * env var it replaces; unset ones fall back to the env.
 */
interface AccessState {
  admin?: AdminAccount
  mode?: AuthMode
  upstreams?: string[]
  limits?: Partial<Limits>
  tokens: AccessToken[]
}

/** Id for the token from the AUTH_TOKEN env: always valid, managed outside the admin page. */
export const ENV_TOKEN_ID = 'env'

const sha256 = (s: string) => createHash('sha256').update(s).digest()
const scrypt = (password: string, salt: string) => scryptSync(password, salt, 32)

/**
 * Who may connect to this relay and who may manage it, kept in the data dir
 * so the admin page can change everything without a restart.
 */
export class AccessStore {
  private state: AccessState
  private readonly file: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    dataDir: string,
    private readonly defaults: {
      mode: AuthMode
      envToken?: string
      upstreams: string[]
      limits: Limits
    },
  ) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'access.json')
    this.state = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as AccessState)
      : { tokens: [] }
  }

  // ── admin account ──────────────────────────────────────────

  get hasAdmin(): boolean {
    return !!this.state.admin
  }

  get adminName(): string | null {
    return this.state.admin?.username ?? null
  }

  setAdmin(username: string, password: string) {
    const salt = randomBytes(16).toString('hex')
    this.state.admin = { username, salt, hash: scrypt(password, salt).toString('hex') }
    this.save()
  }

  checkAdmin(username: string, password: string): boolean {
    const a = this.state.admin
    if (!a) return false
    const ok = timingSafeEqual(scrypt(password, a.salt), Buffer.from(a.hash, 'hex'))
    return ok && username === a.username
  }

  // ── admission ──────────────────────────────────────────────

  get mode(): AuthMode {
    return this.state.mode ?? this.defaults.mode
  }

  setMode(mode: AuthMode) {
    this.state.mode = mode
    this.save()
  }

  /** Normalized base URLs whose API keys may use this relay in upstream mode. */
  get upstreams(): string[] {
    return (this.state.upstreams ?? this.defaults.upstreams).map(normalizeUpstream)
  }

  /** Throws on an invalid URL. */
  setUpstreams(urls: string[]) {
    const list = [
      ...new Set(
        urls
          .map((u) => u.trim())
          .filter(Boolean)
          .map(normalizeUpstream),
      ),
    ]
    for (const u of list)
      if (!/^https?:$/.test(new URL(u).protocol)) throw new Error(`${u} 不是 http(s) 地址`)
    this.state.upstreams = list
    this.save()
  }

  get limits(): Limits {
    return { ...this.defaults.limits, ...this.state.limits }
  }

  setLimits(limits: Partial<Limits>) {
    this.state.limits = { ...this.state.limits, ...limits }
    this.save()
  }

  get hasEnvToken(): boolean {
    return !!this.defaults.envToken
  }

  list(): AccessToken[] {
    return this.state.tokens
  }

  create(name: string): { token: string; entry: AccessToken } {
    const token = `adr_${randomBytes(24).toString('base64url')}`
    const entry: AccessToken = {
      id: randomBytes(8).toString('hex'),
      name: name.trim().slice(0, 60) || '未命名',
      prefix: token.slice(0, 8),
      hash: sha256(token).toString('hex'),
      createdAt: Date.now(),
      lastUsedAt: null,
    }
    this.state.tokens.push(entry)
    this.save()
    return { token, entry }
  }

  revoke(id: string): boolean {
    const before = this.state.tokens.length
    this.state.tokens = this.state.tokens.filter((t) => t.id !== id)
    if (this.state.tokens.length === before) return false
    this.save()
    return true
  }

  /** The id of the token presented, or null. Records when it was last used. */
  match(token: string | undefined): string | null {
    if (!token) return null
    const h = sha256(token)
    if (this.defaults.envToken && timingSafeEqual(h, sha256(this.defaults.envToken)))
      return ENV_TOKEN_ID
    for (const t of this.state.tokens) {
      if (timingSafeEqual(h, Buffer.from(t.hash, 'hex'))) {
        t.lastUsedAt = Date.now()
        this.saveSoon()
        return t.id
      }
    }
    return null
  }

  isValid(id: string): boolean {
    return id === ENV_TOKEN_ID ? this.hasEnvToken : this.state.tokens.some((t) => t.id === id)
  }

  /** Last-used times change on every login; write them lazily. */
  private saveSoon() {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, 30_000)
    this.saveTimer.unref?.()
  }

  private save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  flush() {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.save()
  }
}
