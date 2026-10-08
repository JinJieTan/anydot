import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))
const { unwrapRedirect } = await import('./search')

describe('unwrapRedirect', () => {
  it('decodes Bing click-tracking links', () => {
    const target = 'https://www.electronjs.org/docs/latest/api/utility-process'
    const wrapped = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(target).toString('base64url')}&ntb=1`
    expect(unwrapRedirect(wrapped)).toBe(target)
  })

  it('leaves other links alone', () => {
    expect(unwrapRedirect('https://example.com/a?u=a1xyz')).toBe('https://example.com/a?u=a1xyz')
    expect(unwrapRedirect('not a url')).toBe('not a url')
  })
})
