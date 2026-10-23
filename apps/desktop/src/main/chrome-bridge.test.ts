import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { ChromeBridge, extensionIdFromKey } from './chrome-bridge'

const manifest = JSON.parse(
  readFileSync(join(__dirname, '../../chrome-extension/manifest.json'), 'utf8'),
) as { key: string; version: string }
const ID = extensionIdFromKey(manifest.key)
const PORT = 28741

let bridge: ChromeBridge | null = null
afterEach(() => bridge?.stop())

async function start() {
  bridge = new ChromeBridge({
    allowedIds: [ID],
    appVersion: 'test',
    extensionVersion: manifest.version,
    ports: [PORT],
  })
  await bridge.start()
  return bridge
}

function connect(origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/aitech`, { origin })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

const next = (ws: WebSocket) =>
  new Promise<Record<string, unknown>>((resolve) =>
    ws.once('message', (d) => resolve(JSON.parse(d.toString()))),
  )

describe('ChromeBridge', () => {
  it('derives the fixed extension id from the manifest key', () => {
    expect(ID).toMatch(/^[a-p]{32}$/)
  })

  it('rejects connections from web pages and other extensions', async () => {
    await start()
    await expect(connect('https://evil.example')).rejects.toThrow(/401/)
    await expect(connect('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toThrow(
      /401/,
    )
  })

  it('runs commands through the extension and formats snapshots', async () => {
    const b = await start()
    const ws = await connect(`chrome-extension://${ID}`)
    ws.send(JSON.stringify({ type: 'hello', version: manifest.version, userAgent: 'UA' }))
    expect(await next(ws)).toMatchObject({ type: 'welcome', extensionVersion: manifest.version })
    expect(b.status()).toMatchObject({ connected: true, extensionVersion: manifest.version })

    const reply = b.exec({ action: 'snapshot' })
    const msg = await next(ws)
    expect(msg).toMatchObject({ type: 'exec', cmd: { action: 'snapshot' } })
    ws.send(
      JSON.stringify({
        type: 'result',
        id: msg.id,
        result: {
          text: 'Clicked e1.',
          snapshot: {
            url: 'https://x.test/',
            title: 'X',
            text: '[e1] button "Go"',
            scroll: { y: 0, height: 100, viewport: 50 },
          },
        },
      }),
    )
    expect((await reply).text).toBe(
      'Clicked e1.\nURL: https://x.test/\nTitle: X\nViewport: 0–50 of 100px\n\n[e1] button "Go"',
    )

    const failing = b.exec({ action: 'back' })
    const m2 = await next(ws)
    ws.send(JSON.stringify({ type: 'error', id: m2.id, error: 'boom' }))
    await expect(failing).rejects.toThrow('boom')

    const pending = b.exec({ action: 'screenshot' })
    await next(ws)
    ws.close()
    await expect(pending).rejects.toThrow(/disconnected/)
  })

  it('explains when the extension is not connected', async () => {
    const b = await start()
    await expect(b.exec({ action: 'snapshot' })).rejects.toThrow(/not connected/)
  })
})
