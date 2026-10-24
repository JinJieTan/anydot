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
  log: (...a: unknown[]) => void = () => {},
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
    { fetch: fetchImpl, log },
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
  const USER = 'admin'
  const PASS = 'correct horse'

  /** A relay with its admin account set up; `call` uses the admin session. */
  async function adminRelay(overrides: Partial<RelayConfig> = {}) {
    const logs: string[] = []
    const r = await relay(overrides, undefined, (...a) => logs.push(a.join(' ')))
    const raw = (method: string, path: string, body?: unknown, session = '') =>
      fetch(`${r.url}/admin/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
    let session = ''
    const status = (await (await raw('GET', '/status')).json()) as { setup: boolean }
    if (status.setup) {
      const code = /setup code (\w+)/.exec(logs.join('\n'))![1]
      const res = await raw('POST', '/setup', { code, username: USER, password: PASS })
      session = ((await res.json()) as { session: string }).session
    } else {
      const res = await raw('POST', '/login', { username: USER, password: PASS })
      session = ((await res.json()) as { session: string }).session
    }
    const call = (method: string, path: string, body?: unknown) => raw(method, path, body, session)
    return { r, raw, call, logs }
  }

  it('creates the admin account only with the setup code from the log', async () => {
    const logs: string[] = []
    const r = await relay({}, undefined, (...a) => logs.push(a.join(' ')))
    const post = (path: string, body: unknown) =>
      fetch(`${r.url}/admin/api${path}`, { method: 'POST', body: JSON.stringify(body) })

    const page = await fetch(`${r.url}/admin`)
    expect(page.status).toBe(200)
    expect(page.headers.get('access-control-allow-origin')).toBeNull()
    expect(await page.text()).toContain('AnyDot 中继管理')

    expect(await (await fetch(`${r.url}/admin/api/status`)).json()).toEqual({ setup: true })
    expect(
      (await post('/setup', { code: 'WRONG123', username: USER, password: PASS })).status,
    ).toBe(403)
    const code = /setup code (\w+)/.exec(logs.join('\n'))![1]
    expect((await post('/setup', { code, username: USER, password: 'short' })).status).toBe(400)
    expect((await post('/setup', { code, username: USER, password: PASS })).status).toBe(200)
    // Only once.
    expect((await post('/setup', { code, username: 'eve', password: PASS })).status).toBe(409)

    expect((await post('/login', { username: USER, password: 'nope-nope' })).status).toBe(401)
    expect((await post('/login', { username: USER, password: PASS })).status).toBe(200)
    expect((await fetch(`${r.url}/admin/api/state`)).status).toBe(401)
  })

  it('locks out an address after repeated wrong passwords', async () => {
    const { r, raw } = await adminRelay()
    for (let i = 0; i < 10; i++) await raw('POST', '/login', { username: USER, password: `x${i}` })
    expect((await raw('POST', '/login', { username: USER, password: PASS })).status).toBe(429)
    expect(r.access.hasAdmin).toBe(true)
  })

  it('changing the password ends other sessions', async () => {
    const { raw, call } = await adminRelay()
    const other = (
      (await (await raw('POST', '/login', { username: USER, password: PASS })).json()) as {
        session: string
      }
    ).session
    expect(
      (await call('PUT', '/account', { current: 'wrong-pass', password: 'new password' })).status,
    ).toBe(403)
    const res = await call('PUT', '/account', { current: PASS, password: 'new password' })
    expect(res.status).toBe(200)
    expect((await raw('GET', '/state', undefined, other)).status).toBe(401)
    expect((await raw('POST', '/login', { username: USER, password: 'new password' })).status).toBe(
      200,
    )
  })

  it('switches open to token-only, admits created tokens and kicks revoked ones', async () => {
    const { r, call } = await adminRelay()
    const anyone = client(r.url)
    await until(() => anyone.c.state === 'online')

    // No token yet: switching would lock everyone out.
    expect((await call('PUT', '/mode', { mode: 'token' })).status).toBe(400)

    const created = (await (await call('POST', '/tokens', { name: '小王' })).json()) as {
      token: string
      id: string
    }
    expect(created.token).toMatch(/^adr_/)
    const state = await (await call('PUT', '/mode', { mode: 'token' })).json()
    expect(state).toMatchObject({ mode: 'token', tokens: [{ name: '小王', connections: 0 }] })
    expect(JSON.stringify(state)).not.toContain(created.token)

    // The open-mode client is dropped and the relay now advertises token auth.
    await until(() => anyone.c.state === 'unauthorized')
    expect(await (await fetch(`${r.url}/info`)).json()).toMatchObject({ auth: 'token' })

    const holder = client(r.url, { auth: { token: created.token } })
    const stranger = client(r.url, { auth: { token: 'adr_guess' } })
    await until(() => holder.c.state === 'online' && stranger.c.state === 'unauthorized')
    const after = await (await call('GET', '/state')).json()
    expect(after).toMatchObject({ tokens: [{ connections: 1 }], online: { mobiles: 1 } })

    expect((await call('DELETE', `/tokens/${created.id}`)).status).toBe(200)
    await until(() => holder.c.state === 'unauthorized')

    // Back to open: anyone gets in again.
    await call('PUT', '/mode', { mode: 'open' })
    const later = client(r.url)
    await until(() => later.c.state === 'online')
  })

  it('configures upstream mode and limits from the admin page', async () => {
    const fakeFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const logs: string[] = []
    const r = await relay({}, fakeFetch, (...a) => logs.push(a.join(' ')))
    const code = /setup code (\w+)/.exec(logs.join('\n'))![1]
    const login = await fetch(`${r.url}/admin/api/setup`, {
      method: 'POST',
      body: JSON.stringify({ code, username: USER, password: PASS }),
    })
    const { session } = (await login.json()) as { session: string }
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${r.url}/admin/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${session}` },
        body: JSON.stringify(body),
      })

    expect((await call('PUT', '/mode', { mode: 'upstream' })).status).toBe(400)
    expect((await call('PUT', '/upstreams', { upstreams: ['ftp://x'] })).status).toBe(400)
    const saved = await (
      await call('PUT', '/upstreams', { upstreams: ['https://api.example.com/'] })
    ).json()
    expect(saved).toMatchObject({ upstreams: ['https://api.example.com/v1'] })
    expect((await call('PUT', '/mode', { mode: 'upstream' })).status).toBe(200)

    const user = client(r.url, { auth: { baseUrl: 'https://api.example.com', apiKey: 'sk-1' } })
    await until(() => user.c.state === 'online')
    // Dropping its provider from the list disconnects it.
    expect((await call('PUT', '/upstreams', { upstreams: [] })).status).toBe(400)
    await call('PUT', '/upstreams', { upstreams: ['https://other.example.com'] })
    await until(() => user.c.state === 'unauthorized')

    expect((await call('PUT', '/limits', { messageRate: 0 })).status).toBe(400)
    const limited = await (await call('PUT', '/limits', { maxConnectionsPerIp: 1 })).json()
    expect(limited).toMatchObject({ limits: { maxConnectionsPerIp: 1, messageRate: 50 } })
  })

  it('keeps the AUTH_TOKEN env token and remembers settings across restarts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const first = await adminRelay({ dataDir, auth: 'token', authToken: 'env-secret' })
    expect(await (await first.call('GET', '/state')).json()).toMatchObject({
      mode: 'token',
      hasEnvToken: true,
    })
    expect((await first.call('DELETE', '/tokens/env')).status).toBe(400)
    const envClient = client(first.r.url, { auth: { token: 'env-secret' } })
    await until(() => envClient.c.state === 'online')

    await first.call('PUT', '/mode', { mode: 'open' })
    await first.r.close()

    // Same data dir: no new setup code, same account, saved mode wins over AUTH_MODE.
    const second = await adminRelay({ dataDir, auth: 'token', authToken: 'env-secret' })
    expect(second.logs.join()).not.toContain('setup code')
    expect((await second.call('GET', '/state')).status).toBe(200)
    expect(await (await fetch(`${second.r.url}/info`)).json()).toMatchObject({ auth: 'open' })
  })
})
