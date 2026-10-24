import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthMode } from '@aitech/protocol'

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

interface AccessState {
  /** Set once the admin changes it; until then the AUTH_MODE env decides. */
  mode?: AuthMode
  tokens: AccessToken[]
}

/** Id for the token from the AUTH_TOKEN env: always valid, managed outside the admin page. */
export const ENV_TOKEN_ID = 'env'

const sha256 = (s: string) => createHash('sha256').update(s).digest()

/**
 * Who may connect to this relay: the admission mode and the access tokens,
 * kept in the data dir so the admin page can change them without a restart.
 */
export class AccessStore {
  private state: AccessState
  private readonly file: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    dataDir: string,
    private readonly defaults: { mode: AuthMode; envToken?: string },
  ) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'access.json')
    this.state = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as AccessState)
      : { tokens: [] }
  }

  get mode(): AuthMode {
    return this.state.mode ?? this.defaults.mode
  }

  setMode(mode: AuthMode) {
    this.state.mode = mode
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
