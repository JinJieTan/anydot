import { createHash } from 'node:crypto'
import type { AuthMode, ClientAuth } from '@aitech/protocol'
import type { AccessStore } from './access'

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

/** How a connection got in, so it can be re-checked when the admin changes access. */
export interface Admission {
  mode: AuthMode
  /** token mode: which access token was used. */
  tokenId?: string
  /** upstream mode: which provider vouched for it. */
  upstream?: string
}

/**
 * Decide whether a client may use this relay: an Admission, or why not.
 * Only admission is checked here; what a device may do to another device is
 * decided by the devices themselves through pairing.
 */
export async function admit(
  access: AccessStore,
  auth: ClientAuth | undefined,
  doFetch: typeof fetch = fetch,
): Promise<Admission | string> {
  const mode = access.mode
  switch (mode) {
    case 'open':
      return { mode }
    case 'token': {
      const tokenId = access.match(auth?.token)
      return tokenId ? { mode, tokenId } : '需要正确的访问令牌'
    }
    case 'upstream': {
      if (!auth?.baseUrl || !auth.apiKey) return '需要提供服务商 Base URL 和 API Key'
      let base: string
      try {
        base = normalizeUpstream(auth.baseUrl)
      } catch {
        return 'Base URL 无效'
      }
      if (!access.upstreams.includes(base)) return '该服务商不在此中继的允许列表中'
      // Cache by hash: the relay never stores keys.
      const id = createHash('sha256').update(`${base}|${auth.apiKey}`).digest('hex')
      const hit = cache.get(id)
      if (hit && hit.until > Date.now()) return hit.ok ? { mode, upstream: base } : 'API Key 无效'
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
      return ok ? { mode, upstream: base } : 'API Key 无效'
    }
  }
}

/** Whether a connection admitted earlier still may stay after an access change. */
export function stillAdmitted(a: Admission, access: AccessStore): boolean {
  switch (access.mode) {
    case 'open':
      return true
    case 'token':
      return a.mode === 'token' && !!a.tokenId && access.isValid(a.tokenId)
    case 'upstream':
      return a.mode === 'upstream' && !!a.upstream && access.upstreams.includes(a.upstream)
  }
}
