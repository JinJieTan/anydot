import { openDatabase as openNodeDatabase, Store as NodeStore } from '@aitech/db'
import { Store } from '@aitech/db/browser'
import { startMockServer, type MockServer } from '@aitech/core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importData } from '../../../desktop/src/main/data-transfer'
import { ImageService } from '../../../desktop/src/main/image-service'
import { loadSettings } from '../../../desktop/src/shared/handlers'
import type { ChatStreamEvent, EventName } from '../../../desktop/src/shared/ipc'
import { WEB_SUPPORT, type HandlerMap, type WorkerRpc } from '../protocol'
import { WebBlobs } from './blobs'
import { WebChatService } from './chat'
import { createHandlers } from './handlers'
import { openDatabase } from './sqlite'

// Node has no OPFS, so this runs the real SQLite WASM build on its in-memory fallback.
const plainKey = {
  encryptKey: async (k: string) => `plain:${btoa(k)}`,
  decryptKey: async (ref: string | null) => (ref?.startsWith('plain:') ? atob(ref.slice(6)) : null),
}

let mock: MockServer
let backend: Awaited<ReturnType<typeof setup>>

async function setup() {
  const opened = await openDatabase()
  const store = new Store(opened.db, 'web-test')
  const blobs = await WebBlobs.open(store, false)
  const events: { name: EventName; payload: unknown }[] = []
  const chatEvents: ChatStreamEvent[] = []
  const emit = (name: EventName, payload: unknown) => {
    events.push({ name, payload })
    if (name === 'chat') chatEvents.push(payload as ChatStreamEvent)
  }
  const chat = new WebChatService(
    store,
    blobs,
    () => loadSettings(store),
    plainKey.decryptKey,
    (e) => emit('chat', e),
  )
  const images = new ImageService(store, blobs, (job) => emit('image', job), plainKey.decryptKey)
  const h = createHandlers({
    db: opened.db,
    store,
    blobs,
    chat,
    images,
    storage: opened.storage,
    version: 'test',
    ...plainKey,
    persistKeys: async () => {},
    emit,
    close: opened.close,
  })
  return { opened, store, h, events, chatEvents }
}

async function idle(h: HandlerMap<WorkerRpc>) {
  for (let i = 0; i < 200 && (await h['chat.running']()).length; i++)
    await new Promise((r) => setTimeout(r, 10))
}

beforeEach(async () => {
  mock = await startMockServer({
    reply: (r) => ({ reasoning: 'hm', text: `echo ${r.lastUserText}` }),
  })
  backend = await setup()
})
afterEach(async () => {
  backend.opened.close()
  await mock.close()
})

describe('web backend', () => {
  it('answers every worker and stub method of WEB_SUPPORT, and nothing else public', () => {
    const served = Object.keys(backend.h).filter((m) => !m.startsWith('__'))
    const expected = Object.entries(WEB_SUPPORT)
      .filter(([, s]) => s === 'worker' || s === 'stub')
      .map(([m]) => m)
    expect(served.sort()).toEqual(expected.sort())
  })

  it('falls back to an in-memory database without OPFS', () => {
    expect(backend.opened.storage).toBe('memory')
  })

  it('chats through a provider: stream, title, regenerate as a branch', async () => {
    const { h, chatEvents } = backend
    const p = await h['providers.create']({
      name: 'mock',
      baseUrl: mock.url,
      type: 'auto',
      apiKey: 'sk-test',
    })
    expect(p.hasKey).toBe(true)
    expect(await h['providers.syncModels'](p.id)).toEqual({ added: 4, total: 4 })

    const c = await h['conversations.create']()
    await h['chat.send']({ conversationId: c.id, text: '你好', attachments: [] })
    await idle(h)
    let detail = (await h['conversations.get'](c.id))!
    expect(detail.conversation.title).toBe('你好')
    const [user, reply] = detail.messages
    expect(reply).toMatchObject({ role: 'assistant', status: 'complete', parentId: user!.id })
    expect(reply!.parts).toEqual([
      { type: 'reasoning', text: 'hm' },
      { type: 'text', text: 'echo 你好' },
    ])
    expect(chatEvents.some((e) => e.type === 'delta')).toBe(true)

    await h['chat.regenerate']({ conversationId: c.id, userMessageId: user!.id })
    await idle(h)
    detail = (await h['conversations.get'](c.id))!
    expect(detail.messages.filter((m) => m.parentId === user!.id)).toHaveLength(2)
  })

  it('exports a backup the desktop app can import', async () => {
    const { h } = backend
    const p = await h['providers.create']({
      name: 'mock',
      baseUrl: mock.url,
      type: 'auto',
      apiKey: 'sk-test',
    })
    await h['providers.syncModels'](p.id)
    const c = await h['conversations.create']()
    const att = await h['blobs.put']({
      data: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      name: 'a.png',
    })
    await h['chat.send']({ conversationId: c.id, text: '图', attachments: [att] })
    await idle(h)

    const zip = await h['__data.export']()
    const desktop = new NodeStore(openNodeDatabase(':memory:'), 'desktop')
    const put: string[] = []
    const counts = await importData(
      desktop.db,
      { put: async (_d, m) => (put.push(m), 'x'), read: async () => new Uint8Array() },
      zip,
    )
    expect(counts).toMatchObject({ providers: 1, conversations: 1, messages: 2 })
    expect(put).toEqual(['image/png'])
    // Keys never leave the browser.
    expect(desktop.listProviders()[0]!.keyRef).toBeNull()
  })

  it('refuses project conversations', async () => {
    await expect(
      Promise.resolve().then(() => backend.h['conversations.create']({ projectId: 'p' })),
    ).rejects.toThrow('网页版没有项目')
  })
})
