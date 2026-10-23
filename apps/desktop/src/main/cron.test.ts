import { describe, expect, it } from 'vitest'
import { nextRun, parseCron } from './cron'

const at = (s: string) => new Date(s).getTime()
const iso = (t: number | null) => (t === null ? null : new Date(t).toString())

describe('cron', () => {
  it('finds the next run', () => {
    // 2026-10-23 is a Friday.
    expect(iso(nextRun('0 9 * * *', at('2026-10-23T08:30:00')))).toBe(
      new Date('2026-10-23T09:00:00').toString(),
    )
    expect(iso(nextRun('0 9 * * *', at('2026-10-23T09:00:00')))).toBe(
      new Date('2026-10-24T09:00:00').toString(),
    )
    expect(iso(nextRun('30 8 * * 1-5', at('2026-10-23T09:00:00')))).toBe(
      new Date('2026-10-26T08:30:00').toString(),
    )
    expect(iso(nextRun('*/15 * * * *', at('2026-10-23T10:07:12')))).toBe(
      new Date('2026-10-23T10:15:00').toString(),
    )
    expect(iso(nextRun('0 0 1 1 *', at('2026-10-23T00:00:00')))).toBe(
      new Date('2027-01-01T00:00:00').toString(),
    )
    // Sunday as 7; either day field matches when both are set.
    expect(iso(nextRun('0 12 * * 7', at('2026-10-23T00:00:00')))).toBe(
      new Date('2026-10-25T12:00:00').toString(),
    )
    expect(iso(nextRun('0 12 1 * 0', at('2026-10-23T00:00:00')))).toBe(
      new Date('2026-10-25T12:00:00').toString(),
    )
    expect(nextRun('0 0 31 2 *', at('2026-10-23T00:00:00'))).toBeNull()
  })

  it('rejects bad expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 个字段/)
    expect(() => parseCron('60 * * * *')).toThrow(/分钟/)
    expect(() => parseCron('a * * * *')).toThrow(/无效/)
    expect(() => parseCron('*/0 * * * *')).toThrow()
  })
})
