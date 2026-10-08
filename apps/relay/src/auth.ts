import { createHash, timingSafeEqual } from 'node:crypto'
import type { ClientAuth } from '@aitech/protocol'
import type { RelayConfig } from './config'

/** "https://Host/v1/" → "https://host/v1" for allow-list comparison. */
export function normalizeUpstream(url: string): string {
  const u = new URL(url.trim())
  const path = u.pathname.replace(/\/+$/, '')
  u.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  u.search = ''
  u.hash = ''
  return u.toString().replace(/\/+$/, '')
}

const cache = new Map<string, { ok: boolean; until: number }>()

/**
 * Decide whether a client may use this relay. Only admission is checked here;
 * what a device may do to another device is decided by the devices themselves
 * through pairing.
 */
export async function admit(
  config: RelayConfig,
  auth: ClientAuth | undefined,
  doFetch: typeof fetch = fetch,
): Promise<string | null> {
  switch (config.auth) {
    case 'open':
      return null
    case 'token': {
      const a = Buffer.from(auth?.token ?? '')
      const b = Buffer.from(config.authToken ?? '')
      return a.length === b.length && timingSafeEqual(a, b) ? null : '需要正确的访问令牌'
    }
    case 'upstream': {
      if (!auth?.baseUrl || !auth.apiKey) return '需要提供服务商 Base URL 和 API Key'
      let base: string
      try {
        base = normalizeUpstream(auth.baseUrl)
      } catch {
        return 'Base URL 无效'
      }
      if (!config.allowedUpstreams.map(normalizeUpstream).includes(base))
        return '该服务商不在此中继的允许列表中'
      // Cache by hash: the relay never stores keys.
      const id = createHash('sha256').update(`${base}|${auth.apiKey}`).digest('hex')
      const hit = cache.get(id)
      if (hit && hit.until > Date.now()) return hit.ok ? null : 'API Key 无效'
      let ok: boolean
      try {
        const res = await doFetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${auth.apiKey}` },
          signal: AbortSignal.timeout(10_000),
        })
        ok = res.ok
      } catch {
        return '无法连接服务商验证 Key，请稍后重试'
      }
      cache.set(id, { ok, until: Date.now() + (ok ? 10 * 60_000 : 60_000) })
      if (cache.size > 10_000) cache.clear()
      return ok ? null : 'API Key 无效'
    }
  }
}
