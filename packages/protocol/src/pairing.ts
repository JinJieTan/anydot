import { b64url, fromB64url } from './crypto'
import type { PairingPayload } from './messages'

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * Pairing link. The payload lives in the URL fragment, which browsers never
 * send to a server, so scanning the QR with the phone camera opens the web app
 * without leaking the code.
 */
export function pairingLink(appUrl: string, payload: PairingPayload): string {
  const u = new URL(appUrl)
  u.hash = `pair=${b64url(enc.encode(JSON.stringify(payload)))}`
  return u.toString()
}

export function parsePairing(input: string): PairingPayload | null {
  const m = /pair=([A-Za-z0-9_-]+)/.exec(input)
  if (!m) return null
  try {
    const p = JSON.parse(dec.decode(fromB64url(m[1]!))) as PairingPayload
    if (p.v !== 1 || !p.r || !p.d || !p.k || !p.c) return null
    return p
  } catch {
    return null
  }
}
