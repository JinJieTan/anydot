import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * A device's long-term identity: one Ed25519 key. It signs relay logins and,
 * converted to X25519, is used for end-to-end encryption with paired devices.
 */
export interface Identity {
  secretKey: Uint8Array
  publicKey: Uint8Array
  /** Short stable id derived from the public key. */
  deviceId: string
}

export function deviceIdOf(publicKey: Uint8Array): string {
  return b64url(sha256(publicKey)).slice(0, 22)
}

export function createIdentity(secretKey: Uint8Array = ed25519.utils.randomSecretKey()): Identity {
  const publicKey = ed25519.getPublicKey(secretKey)
  return { secretKey, publicKey, deviceId: deviceIdOf(publicKey) }
}

export function sign(identity: Identity, message: string): string {
  return b64url(ed25519.sign(enc.encode(message), identity.secretKey))
}

export function verify(publicKey: Uint8Array, message: string, signature: string): boolean {
  try {
    return ed25519.verify(fromB64url(signature), enc.encode(message), publicKey)
  } catch {
    return false
  }
}

/** Message a client signs to log in to a relay. */
export const authMessage = (nonce: string) => `aitech-relay-auth:v1:${nonce}`

/**
 * Symmetric key shared by two devices, from static X25519 ECDH. Both sides
 * derive the same key; anyone else (including the relay) cannot.
 */
export function sharedKey(me: Identity, peerPublicKey: Uint8Array): Uint8Array {
  const secret = x25519.getSharedSecret(
    ed25519.utils.toMontgomerySecret(me.secretKey),
    ed25519.utils.toMontgomery(peerPublicKey),
  )
  const ids = [me.deviceId, deviceIdOf(peerPublicKey)].sort().join('|')
  return hkdf(sha256, secret, undefined, enc.encode(`aitech-e2e-v1|${ids}`), 32)
}

/**
 * Encrypt with XChaCha20-Poly1305. `aad` binds the ciphertext to its sender
 * and recipient so the relay can't redirect or reflect it.
 */
export function seal(key: Uint8Array, plaintext: string, aad: string): string {
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(key, nonce, enc.encode(aad)).encrypt(enc.encode(plaintext))
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce)
  out.set(ct, nonce.length)
  return b64url(out)
}

export function open(key: Uint8Array, sealed: string, aad: string): string {
  const bytes = fromB64url(sealed)
  if (bytes.length < 24 + 16) throw new Error('ciphertext too short')
  const pt = xchacha20poly1305(key, bytes.subarray(0, 24), enc.encode(aad)).decrypt(
    bytes.subarray(24),
  )
  return dec.decode(pt)
}

export function randomId(bytes = 12): string {
  return b64url(randomBytes(bytes))
}

/** Human-friendly one-time pairing code, e.g. "4F7K-9QXA". No 0/O/1/I. */
export function pairingCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  const bytes = randomBytes(8)
  let s = ''
  for (const b of bytes) s += alphabet[b % alphabet.length]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}
