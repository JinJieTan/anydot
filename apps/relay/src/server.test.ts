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
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-'))
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
