import { BlockList, isIP } from 'node:net'

/**
 * Peers whose X-Forwarded-For we believe: loopback, plus `TRUSTED_PROXIES`
 * (IPs or CIDRs). Behind Docker's port publishing nginx reaches the relay from
 * the bridge gateway (e.g. 172.17.0.1), not loopback, so that range must be listed.
 */
export function trustedProxies(entries: string[]): BlockList {
  const list = new BlockList()
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addAddress('::1', 'ipv6')
  for (const entry of entries) {
    const [addr = '', bits] = entry.split('/')
    const version = isIP(addr)
    if (!version || (bits !== undefined && !/^\d+$/.test(bits)))
      throw new Error(`TRUSTED_PROXIES: invalid address ${entry}`)
    const family = version === 6 ? 'ipv6' : 'ipv4'
    if (bits === undefined) list.addAddress(addr, family)
    else list.addSubnet(addr, Number(bits), family)
  }
  return list
}

/** "::ffff:1.2.3.4" → "1.2.3.4", so IPv4 rules and per-IP buckets match. */
function plain(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip
}

/**
 * The client's address: the socket peer, unless that peer is a trusted proxy —
 * then the last X-Forwarded-For hop, the one that proxy appended. Earlier hops
 * come from the client and can be forged.
 */
export function clientIp(
  remote: string | undefined,
  forwarded: string | string[] | undefined,
  trusted: BlockList,
): string {
  const peer = plain(remote ?? '')
  const version = isIP(peer)
  if (!forwarded || !version || !trusted.check(peer, version === 6 ? 'ipv6' : 'ipv4')) return peer
  const hops = String(forwarded)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const last = plain(hops.at(-1) ?? '')
  return isIP(last) ? last : peer
}
