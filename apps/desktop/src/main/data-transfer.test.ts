import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, Store } from '@aitech/db'
import { afterEach, describe, expect, it } from 'vitest'
import { BlobStore } from './blobs'
import { exportData, importData } from './data-transfer'

const dirs: string[] = []
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aitech-test-'))
  dirs.push(dir)
  const store = new Store(openDatabase(':memory:'), 'dev')
  return { store, blobs: new BlobStore(join(dir, 'blobs'), store) }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('export / import', () => {
  it('round-trips conversations, messages and blobs without keys', async () => {
    const a = setup()
    const p = a.store.createProvider({
      name: 'gw',
      baseUrl: 'https://x',
      type: 'auto',
      keyRef: 'os:secret',
    })
    a.store.syncModels(p.id, [{ id: 'gpt-5', capabilities: ['chat'] }])
    const model = a.store.listModels(p.id)[0]!
    const c = a.store.createConversation({ title: 'hello', modelId: model.id })
    const sha = await a.blobs.put(new Uint8Array([1, 2, 3]), 'image/png')
    const u = a.store.addMessage({
      conversationId: c.id,
      parentId: null,
      role: 'user',
      parts: [{ type: 'image', blob: sha, mime: 'image/png' }],
    })
    a.store.addMessage({
      conversationId: c.id,
      parentId: u.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'hi' }],
    })
    // A deleted model still referenced by a live conversation must not break import.
    a.store.deleteModel(model.id)

    const zip = await exportData(a.store.db, a.blobs)

    const b = setup()
    const counts = await importData(b.store.db, b.blobs, zip)
    expect(counts).toEqual({ providers: 1, conversations: 1, messages: 2, imageJobs: 0 })
    expect(b.store.getConversation(c.id)?.title).toBe('hello')
    expect(b.store.listMessages(c.id)).toHaveLength(2)
    expect(b.store.listProviders()[0]?.keyRef).toBeNull()
    expect([...(await b.blobs.read(sha))]).toEqual([1, 2, 3])

    // Importing again is a no-op.
    expect(await importData(b.store.db, b.blobs, zip)).toEqual({
      providers: 0,
      conversations: 0,
      messages: 0,
      imageJobs: 0,
    })
    // FK enforcement is restored afterwards.
    const fk = b.store.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
  })

  it('rejects files that are not exports', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const b = setup()
    await expect(
      importData(b.store.db, b.blobs, zipSync({ 'x.txt': strToU8('x') })),
    ).rejects.toThrow(/data.json/)
  })
})
