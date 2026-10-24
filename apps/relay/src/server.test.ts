import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createIdentity,
  RelayClient,
  type IncomingMessage,
  type RelayStatus,
} from '@aitech/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { RelayConfig } from './config'
import { startRelay, type RelayServer } from './server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function relay(
  overrides: Partial<RelayConfig> = {},
  fetchImpl?: typeof fetch,
): Promise<RelayServer> {
  const dataDir = overrides.dataDir ?? mkdtempSync(join(tmpdir(), 'relay-'))
  const r = await startRelay(
    {
      port: 0,
      host: '127.0.0.1',
      auth: 'open',
      allowedUpstreams: [],
      dataDir,
      vapidSubject: 'mailto:test@example.com',
      maxConnectionsPerIp: 20,
      messageRate: 50,
      ...overrides,
    },
    { fetch: fetchImpl, log: () => {} },
  )
  cleanups.push(
    () => rmSync(dataDir, { recursive: true, force: true }),
    () => r.close(),
  )
  return r
}

function client(
  url: string,
  opts: {
    auth?: RelayConfig['authToken'] extends never ? never : Record<string, string>
    kind?: 'desktop' | 'mobile'
  } = {},
) {
  const identity = createIdentity()
  const inbox: IncomingMessage[] = []
  const statuses: RelayStatus[] = []
  const c = new RelayClient({
    url,
    identity,
    kind: opts.kind ?? 'mobile',
    auth: opts.auth,
    onMessage: (m) => inbox.push(m),
    onStatus: (s) => statuses.push(s),
  })
  c.connect()
  cleanups.push(() => c.close())
  return { c, identity, inbox, statuses }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('relay', () => {
  it('serves /info', async () => {
    const r = await relay()
    const info = await (await fetch(`${r.url}/info`)).json()
    expect(info).toMatchObject({
      name: 'aitech-relay',
      auth: 'open',
      vapidPublicKey: expect.any(String),
    })
  })

  it('logs in, forwards encrypted messages, reports presence and offline peers', async () => {
    const r = await relay()
    const a = client(r.url, { kind: 'desktop' })
    const b = client(r.url)
    await until(() => a.c.state === 'online' && b.c.state === 'online')

    await a.c.send(b.identity.publicKey, { type: 'event', name: 'hello', data: { x: 1 } })
    await until(() => b.inbox.length === 1)
    expect(b.inbox[0]).toMatchObject({
      from: a.identity.deviceId,
      body: { type: 'event', name: 'hello', data: { x: 1 } },
    })

    expect(await a.c.presence([b.identity.deviceId, 'nobody'])).toEqual({
      [b.identity.deviceId]: true,
      nobody: false,
    })
    await expect(a.c.send(createIdentity().publicKey, { type: 'unpaired' })).rejects.toMatchObject({
      code: 'offline',
    })
  })

  it('token mode rejects clients without the token', async () => {
    const r = await relay({ auth: 'token', authToken: 'secret' })
    const bad = client(r.url, { auth: { token: 'nope' } })
    const good = client(r.url, { auth: { token: 'secret' } })
    await until(() => bad.c.state === 'unauthorized' && good.c.state === 'online')
  })

  it('upstream mode verifies keys against an allowed base URL', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push(String(url))
      const auth = new Headers(init?.headers).get('authorization')
      return new Response('{}', { status: auth === 'Bearer sk-good' ? 200 : 401 })
    }) as typeof fetch
    const r = await relay(
      { auth: 'upstream', allowedUpstreams: ['https://api.example.com'] },
      fakeFetch,
    )
    const ok = client(r.url, {
      auth: { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-good' },
    })
    const badKey = client(r.url, { auth: { baseUrl: 'https://api.example.com', apiKey: 'sk-bad' } })
    const otherHost = client(r.url, {
      auth: { baseUrl: 'https://evil.example.com', apiKey: 'sk-good' },
    })
    await until(
      () =>
        ok.c.state === 'online' &&
        badKey.c.state === 'unauthorized' &&
        otherHost.c.state === 'unauthorized',
    )
    expect(calls.every((u) => u === 'https://api.example.com/v1/models')).toBe(true)
  })

  it('drops a forged sender (relay cannot impersonate a device)', async () => {
    const r = await relay()
    const a = client(r.url)
    const b = client(r.url)
    await until(() => a.c.state === 'online' && b.c.state === 'online')
    // Sealed for a different recipient: b must not accept it.
    const eve = createIdentity()
    const { sharedKey, seal } = await import('@aitech/protocol')
    const payload = seal(
      sharedKey(eve, b.identity.publicKey),
      JSON.stringify({ v: 1, id: 'x', ts: Date.now(), body: { type: 'unpaired' } }),
      `${a.identity.deviceId}>${b.identity.deviceId}`,
    )
    // Inject as if from a: decryption with a's key fails, so it's dropped.
    ;(a.c as unknown as { raw: (f: unknown) => void }).raw({
      t: 'send',
      id: 'f1',
      to: b.identity.deviceId,
      payload,
    })
    await new Promise((res) => setTimeout(res, 200))
    expect(b.inbox).toHaveLength(0)
  })
})

describe('relay admin', () => {
  const ADMIN = 'admin-secret-0123456789'
  const api = (r: RelayServer, method: string, path: string, body?: unknown, key = ADMIN) =>
    fetch(`${r.url}/admin/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })

  it('is off without ADMIN_TOKEN and rejects a wrong admin token', async () => {
    const off = await relay()
    expect((await fetch(`${off.url}/admin`)).status).toBe(404)

    const r = await relay({ adminToken: ADMIN })
    const page = await fetch(`${r.url}/admin`)
    expect(page.status).toBe(200)
    expect(page.headers.get('access-control-allow-origin')).toBeNull()
    expect(await page.text()).toContain('AnyDot 中继管理')
    expect((await api(r, 'GET', '/state', undefined, 'wrong')).status).toBe(401)
    expect((await api(r, 'GET', '/state')).status).toBe(200)
  })

  it('locks out an address after repeated wrong admin tokens', async () => {
    const r = await relay({ adminToken: ADMIN })
    for (let i = 0; i < 10; i++) await api(r, 'GET', '/state', undefined, `wrong${i}`)
    expect((await api(r, 'GET', '/state')).status).toBe(429)
  })

  it('switches open to token-only, admits created tokens and kicks revoked ones', async () => {
    const r = await relay({ adminToken: ADMIN })
    const anyone = client(r.url)
    await until(() => anyone.c.state === 'online')

    // No token yet: switching would lock everyone out.
    expect((await api(r, 'PUT', '/mode', { mode: 'token' })).status).toBe(400)

    const created = (await (await api(r, 'POST', '/tokens', { name: '小王' })).json()) as {
      token: string
      id: string
    }
    expect(created.token).toMatch(/^adr_/)
    const state = await (await api(r, 'PUT', '/mode', { mode: 'token' })).json()
    expect(state).toMatchObject({ mode: 'token', tokens: [{ name: '小王', connections: 0 }] })
    expect(JSON.stringify(state)).not.toContain(created.token)

    // The open-mode client is dropped and the relay now advertises token auth.
    await until(() => anyone.c.state === 'unauthorized')
    expect(await (await fetch(`${r.url}/info`)).json()).toMatchObject({ auth: 'token' })

    const holder = client(r.url, { auth: { token: created.token } })
    const stranger = client(r.url, { auth: { token: 'adr_guess' } })
    await until(() => holder.c.state === 'online' && stranger.c.state === 'unauthorized')
    const after = await (await api(r, 'GET', '/state')).json()
    expect(after).toMatchObject({ tokens: [{ connections: 1 }], online: { mobiles: 1 } })

    expect((await api(r, 'DELETE', `/tokens/${created.id}`)).status).toBe(200)
    await until(() => holder.c.state === 'unauthorized')

    // Back to open: anyone gets in again.
    await api(r, 'PUT', '/mode', { mode: 'open' })
    const later = client(r.url)
    await until(() => later.c.state === 'online')
  })

  it('keeps the AUTH_TOKEN env token and remembers the mode across restarts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const first = await relay({
      dataDir,
      auth: 'token',
      authToken: 'env-secret',
      adminToken: ADMIN,
    })
    expect(await (await api(first, 'GET', '/state')).json()).toMatchObject({
      mode: 'token',
      hasEnvToken: true,
      modes: ['open', 'token'],
    })
    expect((await api(first, 'DELETE', '/tokens/env')).status).toBe(400)
    const envClient = client(first.url, { auth: { token: 'env-secret' } })
    await until(() => envClient.c.state === 'online')

    await api(first, 'PUT', '/mode', { mode: 'open' })
    expect((await api(first, 'PUT', '/mode', { mode: 'upstream' })).status).toBe(400)
    await first.close()

    const second = await relay({
      dataDir,
      auth: 'token',
      authToken: 'env-secret',
      adminToken: ADMIN,
    })
    expect(await (await fetch(`${second.url}/info`)).json()).toMatchObject({ auth: 'open' })
  })
})
