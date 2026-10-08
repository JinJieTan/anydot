import { describe, expect, it } from 'vitest'
import { idTimestamp, newId } from './id'

describe('newId', () => {
  it('produces a valid UUIDv7', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('encodes the timestamp', () => {
    const now = 1_760_000_000_123
    expect(idTimestamp(newId(now))).toBe(now)
  })

  it('sorts by creation time', () => {
    const ids = [3, 1, 2].map((t) => newId(1_760_000_000_000 + t))
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]])
  })
})
