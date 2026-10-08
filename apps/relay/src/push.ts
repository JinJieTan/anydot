import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PushSubscriptionJSON } from '@aitech/protocol'
import webpush from 'web-push'

const MAX_PER_DEVICE = 5

/**
 * Web Push delivery. VAPID keys are generated on first start and kept in the
 * data dir. Payloads are end-to-end encrypted by the sender; the relay only
 * wraps them in the Web Push envelope.
 */
export class PushService {
  readonly publicKey: string
  private subs: Record<string, PushSubscriptionJSON[]>
  private readonly subsFile: string

  constructor(dataDir: string, subject: string) {
    mkdirSync(dataDir, { recursive: true })
    const keyFile = join(dataDir, 'vapid.json')
    let keys: { publicKey: string; privateKey: string }
    if (existsSync(keyFile)) {
      keys = JSON.parse(readFileSync(keyFile, 'utf8')) as typeof keys
    } else {
      keys = webpush.generateVAPIDKeys()
      writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 })
    }
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey)
    this.publicKey = keys.publicKey

    this.subsFile = join(dataDir, 'push-subscriptions.json')
    this.subs = existsSync(this.subsFile)
      ? (JSON.parse(readFileSync(this.subsFile, 'utf8')) as Record<string, PushSubscriptionJSON[]>)
      : {}
  }

  private save() {
    const tmp = `${this.subsFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.subs))
    renameSync(tmp, this.subsFile)
  }

  subscribe(deviceId: string, sub: PushSubscriptionJSON) {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys.auth)
      return
    const list = (this.subs[deviceId] ?? []).filter((s) => s.endpoint !== sub.endpoint)
    list.push(sub)
    this.subs[deviceId] = list.slice(-MAX_PER_DEVICE)
    this.save()
  }

  hasSubscription(deviceId: string): boolean {
    return !!this.subs[deviceId]?.length
  }

  async send(deviceId: string, payload: string): Promise<boolean> {
    const list = this.subs[deviceId] ?? []
    let delivered = false
    const keep: PushSubscriptionJSON[] = []
    await Promise.all(
      list.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' })
          delivered = true
          keep.push(sub)
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          // 404/410: subscription is gone for good.
          if (status !== 404 && status !== 410) keep.push(sub)
        }
      }),
    )
    if (keep.length !== list.length) {
      this.subs[deviceId] = keep
      this.save()
    }
    return delivered
  }
}
