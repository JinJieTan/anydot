/**
 * End-to-end application messages between a paired phone and desktop,
 * encrypted inside relay `send` / `msg` frames.
 */
export interface Envelope<T extends AppMessage = AppMessage> {
  v: 1
  /** Unique per message, for replay protection. */
  id: string
  /** Sender clock, ms. */
  ts: number
  body: T
}

export type AppMessage =
  | { type: 'pair.request'; code: string; name: string; platform: string }
  | { type: 'pair.accept'; name: string }
  | { type: 'pair.reject'; reason: string }
  /** Desktop tells a device it is not (or no longer) paired. */
  | { type: 'unpaired' }
  | { type: 'rpc.req'; rid: string; method: string; params?: unknown }
  | { type: 'rpc.res'; rid: string; ok: true; result: unknown }
  | { type: 'rpc.res'; rid: string; ok: false; error: string }
  | { type: 'event'; name: string; data: unknown }

/** Contents of a pairing QR code / link. */
export interface PairingPayload {
  v: 1
  /** Relay base URL. */
  r: string
  /** Desktop device id and public key. */
  d: string
  k: string
  /** One-time pairing code. */
  c: string
  /** Desktop display name. */
  n: string
  /** Expiry, ms since epoch. */
  e: number
  /**
   * Found through the relay by a typed code rather than scanned: the desktop
   * key came via the relay, so the check digits matter. Never in a QR.
   */
  typed?: boolean
}

const MAX_SKEW_MS = 10 * 60_000

/** Rejects stale and repeated messages within the clock-skew window. */
export class ReplayGuard {
  private seen = new Map<string, number>()

  accept(env: Envelope, now = Date.now()): boolean {
    if (env.v !== 1 || typeof env.id !== 'string' || typeof env.ts !== 'number') return false
    if (Math.abs(now - env.ts) > MAX_SKEW_MS) return false
    if (this.seen.has(env.id)) return false
    this.seen.set(env.id, env.ts)
    if (this.seen.size > 5000) {
      for (const [id, ts] of this.seen) if (now - ts > MAX_SKEW_MS) this.seen.delete(id)
    }
    return true
  }
}
