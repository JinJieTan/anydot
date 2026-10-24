/**
 * Relay wire protocol (JSON over WebSocket). The relay sees only these frames:
 * who is online and opaque, end-to-end encrypted payloads.
 */
export type DeviceKind = 'desktop' | 'mobile'

export type AuthMode = 'open' | 'token' | 'upstream'

export interface RelayInfo {
  name: 'aitech-relay'
  version: string
  auth: AuthMode
  /** VAPID public key when Web Push is available. */
  vapidPublicKey?: string
  /** Where the relay serves the mobile web app, if it does. */
  mobileUrl?: string
}

export interface ClientAuth {
  token?: string
  baseUrl?: string
  apiKey?: string
}

export type ClientFrame =
  | {
      t: 'hello'
      v: 1
      deviceId: string
      publicKey: string
      signature: string
      kind: DeviceKind
      auth?: ClientAuth
    }
  | { t: 'send'; id: string; to: string; payload: string }
  | { t: 'push'; id: string; to: string; payload: string }
  | { t: 'push.subscribe'; subscription: PushSubscriptionJSON }
  | { t: 'presence'; id: string; ids: string[] }
  /** Desktop: let phones find it by typing this pairing code (until expiresAt). */
  | { t: 'pair.offer'; id: string; code: string; name: string; expiresAt: number }
  /** Phone: which desktop offered this code? */
  | { t: 'pair.lookup'; id: string; code: string }
  | { t: 'ping' }

export type ServerFrame =
  | { t: 'challenge'; nonce: string; info: RelayInfo }
  | { t: 'ready'; deviceId: string }
  | { t: 'msg'; from: string; fromKey: string; payload: string }
  | { t: 'ack'; id: string }
  | { t: 'error'; id?: string; code: ErrorCode; message: string }
  | { t: 'presence'; id: string; online: Record<string, boolean> }
  | { t: 'pair.found'; id: string; offer: PairingOffer }
  | { t: 'pong' }

export type ErrorCode =
  | 'bad_frame'
  | 'unauthorized'
  | 'offline'
  | 'rate_limited'
  | 'too_large'
  | 'push_unavailable'
  | 'no_subscription'
  | 'not_found'

/** A desktop found by its pairing code. */
export interface PairingOffer {
  deviceId: string
  publicKey: string
  name: string
  expiresAt: number
}

export interface PushSubscriptionJSON {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** /ws endpoint for a relay base URL given as http(s) or ws(s). */
export function wsUrl(relayUrl: string): string {
  const u = new URL(relayUrl)
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:'
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws`
  u.search = ''
  u.hash = ''
  return u.toString()
}

export function infoUrl(relayUrl: string): string {
  const u = new URL(relayUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/info`
  u.search = ''
  u.hash = ''
  return u.toString()
}
