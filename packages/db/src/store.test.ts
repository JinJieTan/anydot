import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from './index'
import { newestLeafFrom, pathToLeaf, Store } from './store'

let store: Store
let clock: number

beforeEach(() => {
  clock = 1_000
  store = new Store(openDatabase(':memory:'), 'dev-1', () => clock++)
})

const provider = () =>
  store.createProvider({ name: 'gw', baseUrl: 'https://x', type: 'auto', keyRef: 'enc:abc' })

describe('providers and models', () => {
  it('syncs models without clobbering user choices', () => {
    const p = provider()
    expect(store.syncModels(p.id, [{ id: 'gpt-5', capabilities: ['chat'] }]).added).toBe(1)
    const m = store.listModels(p.id)[0]!
    store.updateModel(m.id, { enabled: false, protocol: 'openai-chat' })

    const res = store.syncModels(p.id, [
      { id: 'gpt-5', capabilities: ['chat', 'vision'] },
      { id: 'claude-sonnet-5-5', capabilities: ['chat'] },
    ])
    expect(res.added).toBe(1)
    const again = store.getModel(m.id)!
    expect(again.enabled).toBe(false)
    expect(again.protocol).toBe('openai-chat')
    expect(store.listAvailableModels().map((x) => x.modelId)).toEqual(['claude-sonnet-5-5'])
  })

  it('revives a deleted model on re-sync', () => {
    const p = provider()
    store.syncModels(p.id, [{ id: 'gpt-5', capabilities: ['chat'] }])
    store.deleteModel(store.listModels(p.id)[0]!.id)
    expect(store.listModels(p.id)).toHaveLength(0)
    store.syncModels(p.id, [{ id: 'gpt-5', capabilities: ['chat'] }])
    expect(store.listModels(p.id)).toHaveLength(1)
  })

  it('deleting a provider hides its models and drops the key', () => {
    const p = provider()
    store.syncModels(p.id, [{ id: 'gpt-5', capabilities: ['chat'] }])
    store.deleteProvider(p.id)
    expect(store.listProviders()).toHaveLength(0)
    expect(store.listAvailableModels()).toHaveLength(0)
    const raw = store.db.prepare('SELECT key_ref FROM providers WHERE id = ?').get(p.id) as {
      key_ref: string | null
    }
    expect(raw.key_ref).toBeNull()
  })
})

describe('conversations and messages', () => {
  it('tracks the active leaf and branches', () => {
    const c = store.createConversation({ title: 'hi' })
    const u1 = store.addMessage({
      conversationId: c.id,
      parentId: null,
      role: 'user',
      parts: [{ type: 'text', text: 'q' }],
    })
    const a1 = store.addMessage({
      conversationId: c.id,
      parentId: u1.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'a1' }],
    })
    // regenerate: sibling of a1
    const a2 = store.addMessage({
      conversationId: c.id,
      parentId: u1.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'a2' }],
    })

    expect(store.getConversation(c.id)!.activeLeafId).toBe(a2.id)
    const all = store.listMessages(c.id)
    expect(pathToLeaf(all, a2.id).map((m) => m.id)).toEqual([u1.id, a2.id])
    expect(pathToLeaf(all, a1.id).map((m) => m.id)).toEqual([u1.id, a1.id])
    expect(newestLeafFrom(all, u1.id)).toBe(a2.id)
  })

  it('finalises a streaming message', () => {
    const c = store.createConversation()
    const m = store.addMessage({
      conversationId: c.id,
      parentId: null,
      role: 'assistant',
      parts: [],
      status: 'streaming',
    })
    const done = store.finishMessage(m.id, {
      parts: [{ type: 'text', text: 'ok' }],
      status: 'complete',
      usage: { inputTokens: 1, outputTokens: 2 },
    })
    expect(done).toMatchObject({ status: 'complete', usage: { inputTokens: 1, outputTokens: 2 } })
  })

  it('recovers messages left streaming by a crash', () => {
    const c = store.createConversation()
    store.addMessage({
      conversationId: c.id,
      parentId: null,
      role: 'assistant',
      parts: [],
      status: 'streaming',
    })
    expect(store.recoverStreaming()).toBe(1)
    expect(store.listMessages(c.id)[0]!.status).toBe('aborted')
  })

  it('searches titles and message text, escaping LIKE wildcards', () => {
    const a = store.createConversation({ title: 'Rust 入门' })
    const b = store.createConversation({ title: 'other' })
    store.addMessage({
      conversationId: b.id,
      parentId: null,
      role: 'user',
      parts: [{ type: 'text', text: '100% sure' }],
    })
    store.createConversation({ title: 'nothing' })

    expect(store.listConversations({ search: 'rust' }).map((c) => c.id)).toEqual([a.id])
    expect(store.listConversations({ search: '100%' }).map((c) => c.id)).toEqual([b.id])
    expect(store.listConversations({ search: '%' }).map((c) => c.id)).toEqual([b.id])
  })

  it('orders pinned first, then most recently updated', () => {
    const a = store.createConversation({ title: 'a' })
    const b = store.createConversation({ title: 'b' })
    store.updateConversation(a.id, { pinned: true })
    const c = store.createConversation({ title: 'c' })
    expect(store.listConversations().map((x) => x.id)).toEqual([a.id, c.id, b.id])
  })

  it('soft-deletes a conversation with its messages', () => {
    const c = store.createConversation()
    store.addMessage({ conversationId: c.id, parentId: null, role: 'user', parts: [] })
    store.deleteConversation(c.id)
    expect(store.getConversation(c.id)).toBeUndefined()
    expect(store.listMessages(c.id)).toHaveLength(0)
  })
})

describe('image jobs and settings', () => {
  it('records a job lifecycle', () => {
    const job = store.createImageJob({
      prompt: 'cat',
      params: { n: 1 },
      modelId: 'm',
      sourceBlobIds: [],
    })
    expect(job.status).toBe('running')
    const done = store.finishImageJob(job.id, { status: 'done', resultBlobIds: ['abc'] })
    expect(done.resultBlobIds).toEqual(['abc'])
    expect(store.listImageJobs()).toHaveLength(1)
  })

  it('keeps resumable video jobs across a restart', () => {
    const img = store.createImageJob({ prompt: 'a', params: {}, modelId: 'm', sourceBlobIds: [] })
    const vid = store.createImageJob({
      prompt: 'b',
      params: { kind: 'video' },
      modelId: 'sora-2',
      sourceBlobIds: [],
    })
    store.updateImageJobParams(vid.id, { remoteId: 'video_1', progress: 40 })
    expect(store.recoverImageJobs()).toBe(1)
    expect(store.getImageJob(img.id)?.status).toBe('error')
    expect(store.resumableVideoJobs().map((j) => j.params)).toEqual([
      { kind: 'video', remoteId: 'video_1', progress: 40 },
    ])
  })

  it('stores settings as JSON', () => {
    expect(store.getSetting('theme', 'system')).toBe('system')
    store.setSetting('theme', 'dark')
    store.setSetting('theme', 'light')
    expect(store.getSetting('theme', 'system')).toBe('light')
  })
})

describe('projects', () => {
  it('creates, updates and deletes with its conversations', () => {
    const p = store.createProject({ name: 'app', rootPath: '/code/app' })
    expect(p.permissionMode).toBe('ask')
    store.updateProject(p.id, { permissionMode: 'auto-edit', instructions: 'use pnpm' })
    expect(store.getProject(p.id)).toMatchObject({
      permissionMode: 'auto-edit',
      instructions: 'use pnpm',
    })
    const c = store.createConversation({ projectId: p.id })
    store.createConversation()
    expect(store.listConversations({ projectId: p.id }).map((x) => x.id)).toEqual([c.id])
    store.deleteProject(p.id)
    expect(store.listProjects()).toHaveLength(0)
    expect(store.getConversation(c.id)).toBeUndefined()
    expect(store.listConversations()).toHaveLength(1)
  })
})

describe('transaction', () => {
  it('rolls back nested work atomically', () => {
    expect(() =>
      store.transaction(() => {
        store.createConversation({ title: 'outer' })
        store.transaction(() => store.createConversation({ title: 'inner' }))
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(store.listConversations()).toHaveLength(0)
  })
})

describe('trusted devices', () => {
  it('trusts, re-pairs and revokes', () => {
    store.trustDevice({ deviceId: 'd1', name: 'iPhone', platform: 'ios', publicKey: 'k1' })
    expect(store.listTrustedDevices().map((d) => d.name)).toEqual(['iPhone'])
    store.revokeDevice('d1')
    expect(store.getTrustedDevice('d1')).toBeUndefined()
    store.trustDevice({ deviceId: 'd1', name: 'iPhone 2', platform: 'ios', publicKey: 'k1' })
    expect(store.getTrustedDevice('d1')?.name).toBe('iPhone 2')
  })
})

describe('schedules', () => {
  it('creates, updates and soft-deletes; deleting the project removes its schedules', () => {
    const p = store.createProject({ name: 'p', rootPath: '/tmp/p' })
    const s = store.createSchedule({
      name: 'Daily report',
      projectId: p.id,
      prompt: 'summarise yesterday',
      cron: '0 9 * * *',
      modelId: null,
      nextRunAt: 5_000,
    })
    expect(s).toMatchObject({ enabled: true, nextRunAt: 5_000, lastRunAt: null })
    const u = store.updateSchedule(s.id, { enabled: false, lastRunAt: 4_000, lastError: 'x' })
    expect(u).toMatchObject({ enabled: false, lastRunAt: 4_000, lastError: 'x', cron: '0 9 * * *' })
    const chat = store.createSchedule({
      name: 'c',
      projectId: null,
      prompt: 'hi',
      cron: '* * * * *',
      modelId: null,
      nextRunAt: null,
    })
    store.deleteProject(p.id)
    expect(store.listSchedules().map((x) => x.id)).toEqual([chat.id])
    store.deleteSchedule(chat.id)
    expect(store.getSchedule(chat.id)).toBeUndefined()
  })
})
