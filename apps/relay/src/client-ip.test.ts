import { describe, expect, it } from 'vitest'
import { clientIp, trustedProxies } from './client-ip'

describe('clientIp', () => {
  const loopbackOnly = trustedProxies([])
  const docker = trustedProxies(['172.16.0.0/12'])

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(clientIp('203.0.113.5', '198.51.100.1', loopbackOnly)).toBe('203.0.113.5')
    expect(clientIp('172.17.0.1', '198.51.100.1', loopbackOnly)).toBe('172.17.0.1')
  })

  it('takes the last hop from loopback, including IPv4-mapped loopback', () => {
    expect(clientIp('127.0.0.1', '198.51.100.1', loopbackOnly)).toBe('198.51.100.1')
    expect(clientIp('::ffff:127.0.0.1', '198.51.100.1', loopbackOnly)).toBe('198.51.100.1')
    expect(clientIp('::1', '2001:db8::7', loopbackOnly)).toBe('2001:db8::7')
  })

  it('takes the last hop from a configured proxy range (Docker bridge gateway)', () => {
    expect(clientIp('172.17.0.1', '198.51.100.1', docker)).toBe('198.51.100.1')
    expect(clientIp('::ffff:172.17.0.1', '198.51.100.1', docker)).toBe('198.51.100.1')
  })

  it('does not let the client pick its address with a forged first hop', () => {
    // nginx `$proxy_add_x_forwarded_for` appends the real peer after whatever the client sent.
    expect(clientIp('172.17.0.1', '6.6.6.6, 198.51.100.1', docker)).toBe('198.51.100.1')
  })

  it('falls back to the peer when the header is missing or not an address', () => {
    expect(clientIp('172.17.0.1', undefined, docker)).toBe('172.17.0.1')
    expect(clientIp('172.17.0.1', 'unknown', docker)).toBe('172.17.0.1')
    expect(clientIp('172.17.0.1', ' , ', docker)).toBe('172.17.0.1')
  })

  it('normalizes IPv4-mapped peers so per-IP buckets match', () => {
    expect(clientIp('::ffff:203.0.113.5', undefined, loopbackOnly)).toBe('203.0.113.5')
  })
})

describe('trustedProxies', () => {
  it('accepts single addresses and CIDRs of both families', () => {
    const list = trustedProxies(['10.0.0.5', '192.168.0.0/16', 'fd00::/8'])
    expect(list.check('10.0.0.5', 'ipv4')).toBe(true)
    expect(list.check('10.0.0.6', 'ipv4')).toBe(false)
    expect(list.check('192.168.3.4', 'ipv4')).toBe(true)
    expect(list.check('fd12::1', 'ipv6')).toBe(true)
  })

  it('rejects entries that are not addresses', () => {
    expect(() => trustedProxies(['nginx'])).toThrow(/TRUSTED_PROXIES/)
    expect(() => trustedProxies(['10.0.0.0/abc'])).toThrow(/TRUSTED_PROXIES/)
  })
})
