import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Feedback {
  id: string
  message: string
  /** Optional email / WeChat etc. the user left for a reply. */
  contact: string
  /** App version and OS, as reported by the client. */
  version: string
  platform: string
  createdAt: number
}

export const MAX_MESSAGE = 4000
const MAX_KEPT = 2000
const MAX_PER_IP = 5
const IP_WINDOW = 10 * 60_000

/**
 * Feedback sent from the desktop app, read in the admin page. Kept in the data
 * dir; the oldest entries are dropped past MAX_KEPT.
 */
export class FeedbackStore {
  private items: Feedback[]
  private readonly file: string
  private readonly recent = new Map<string, number[]>()

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'feedback.json')
    this.items = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as Feedback[])
      : []
  }

  /** Newest first. */
  list(): Feedback[] {
    return [...this.items].reverse()
  }

  /** Returns an error message, or the stored entry. */
  add(
    input: Record<string, unknown>,
    ip: string,
  ): { error: string; status: number } | { entry: Feedback } {
    const str = (k: string, max: number) =>
      typeof input[k] === 'string' ? (input[k] as string).trim().slice(0, max) : ''
    const message = str('message', MAX_MESSAGE)
    if (!message) return { error: '反馈内容不能为空', status: 400 }

    const now = Date.now()
    const times = (this.recent.get(ip) ?? []).filter((t) => t > now - IP_WINDOW)
    if (times.length >= MAX_PER_IP) return { error: '提交太频繁，请稍后再试', status: 429 }
    times.push(now)
    this.recent.set(ip, times)
    if (this.recent.size > 10_000) this.recent.clear()

    const entry: Feedback = {
      id: randomBytes(8).toString('hex'),
      message,
      contact: str('contact', 200),
      version: str('version', 40),
      platform: str('platform', 40),
      createdAt: now,
    }
    this.items.push(entry)
    if (this.items.length > MAX_KEPT) this.items = this.items.slice(-MAX_KEPT)
    this.save()
    return { entry }
  }

  remove(id: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((f) => f.id !== id)
    if (this.items.length === before) return false
    this.save()
    return true
  }

  private save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.items), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
