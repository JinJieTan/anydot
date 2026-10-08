import { describe, expect, it } from 'vitest'
import { idTimestamp, newId } from './id'

describe('newId', () => {
  it('produces a valid UUIDv7', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('encodes the timestamp', () => {
    const future = Date.now() + 60_000
    expect(idTimestamp(newId(future))).toBe(future)
  })

  it('is monotonic within the same millisecond', () => {
    const t = Date.now() + 120_000
    const ids = Array.from({ length: 50 }, () => newId(t))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(50)
  })

  it('never goes backwards when the clock does', () => {
    const t = Date.now() + 180_000
    const a = newId(t)
    const b = newId(t - 5_000)
    expect(b > a).toBe(true)
  })
})
