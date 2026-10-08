import { describe, expect, it } from 'vitest'
import {
  authMessage,
  createIdentity,
  deviceIdOf,
  open,
  pairingCode,
  seal,
  sharedKey,
  sign,
  verify,
} from './crypto'
import { ReplayGuard } from './messages'
import { pairingLink, parsePairing } from './pairing'
import { infoUrl, wsUrl } from './frames'

describe('identity and signatures', () => {
  it('derives a stable device id and verifies signatures', () => {
    const a = createIdentity()
    expect(createIdentity(a.secretKey).deviceId).toBe(a.deviceId)
    expect(a.deviceId).toBe(deviceIdOf(a.publicKey))
    const sig = sign(a, authMessage('n1'))
    expect(verify(a.publicKey, authMessage('n1'), sig)).toBe(true)
    expect(verify(a.publicKey, authMessage('n2'), sig)).toBe(false)
    expect(verify(createIdentity().publicKey, authMessage('n1'), sig)).toBe(false)
    expect(verify(a.publicKey, 'x', 'garbage')).toBe(false)
  })
})

describe('end-to-end encryption', () => {
  it('both sides derive the same key; others cannot read', () => {
    const a = createIdentity()
    const b = createIdentity()
    const eve = createIdentity()
    const kab = sharedKey(a, b.publicKey)
    expect(sharedKey(b, a.publicKey)).toEqual(kab)
    const aad = `${a.deviceId}>${b.deviceId}`
    const box = seal(kab, 'hello 你好', aad)
    expect(open(kab, box, aad)).toBe('hello 你好')
    expect(() => open(sharedKey(eve, a.publicKey), box, aad)).toThrow()
  })

  it('rejects a message redirected to another recipient (AAD mismatch)', () => {
    const a = createIdentity()
    const b = createIdentity()
    const k = sharedKey(a, b.publicKey)
    const box = seal(k, 'x', `${a.deviceId}>${b.deviceId}`)
    expect(() => open(k, box, `${b.deviceId}>${a.deviceId}`)).toThrow()
  })

  it('rejects tampered ciphertext', () => {
    const a = createIdentity()
    const b = createIdentity()
    const k = sharedKey(a, b.publicKey)
    const box = seal(k, 'x', 'aad')
    const flipped = box.slice(0, -2) + (box.at(-2) === 'A' ? 'B' : 'A') + box.at(-1)
    expect(() => open(k, flipped, 'aad')).toThrow()
  })
})

describe('replay guard', () => {
  it('rejects duplicates and stale messages', () => {
    const g = new ReplayGuard()
    const now = 1_000_000_000
    const body = { type: 'unpaired' as const }
    expect(g.accept({ v: 1, id: 'a', ts: now, body }, now)).toBe(true)
    expect(g.accept({ v: 1, id: 'a', ts: now, body }, now)).toBe(false)
    expect(g.accept({ v: 1, id: 'b', ts: now - 11 * 60_000, body }, now)).toBe(false)
  })
})

describe('pairing link', () => {
  it('round-trips through the URL fragment', () => {
    const payload = {
      v: 1 as const,
      r: 'https://relay.example.com',
      d: 'dev',
      k: 'key',
      c: pairingCode(),
      n: 'Mac',
      e: 1,
    }
    const link = pairingLink('https://relay.example.com/m/', payload)
    expect(link.startsWith('https://relay.example.com/m/#pair=')).toBe(true)
    expect(parsePairing(link)).toEqual(payload)
    expect(parsePairing('https://x/#nothing')).toBeNull()
    expect(payload.c).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
  })
})

describe('urls', () => {
  it('maps relay base urls to ws and info endpoints', () => {
    expect(wsUrl('https://api.x.com/ctl')).toBe('wss://api.x.com/ctl/ws')
    expect(wsUrl('http://127.0.0.1:8090/')).toBe('ws://127.0.0.1:8090/ws')
    expect(infoUrl('wss://api.x.com/ctl')).toBe('https://api.x.com/ctl/info')
  })
})
