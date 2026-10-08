/**
 * UUIDv7 (RFC 9562): 48-bit Unix ms timestamp + random bits.
 * IDs sort by creation time and can be generated on any device without
 * coordination, which keeps future sync merges conflict-free.
 */
let lastTs = -1
let seq = 0

export function newId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  // Monotonic within a process (RFC 9562 §6.2 method 1): ids created in the
  // same millisecond get an increasing 12-bit counter in rand_a, so creation
  // order is preserved when sorting by id.
  let ts = now
  if (ts <= lastTs) {
    ts = lastTs
    seq++
    if (seq > 0xfff) {
      ts++
      seq = 0
    }
  } else {
    seq = 0
  }
  lastTs = ts

  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256
    ts = Math.floor(ts / 256)
  }
  bytes[6] = 0x70 | (seq >> 8) // version 7 + counter high bits
  bytes[7] = seq & 0xff
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Millisecond timestamp encoded in a UUIDv7. */
export function idTimestamp(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}
