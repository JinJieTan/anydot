import { openDatabase, Store } from '@aitech/db'
import { describe, expect, it, vi } from 'vitest'
import type { BlobStore } from './blobs'
import type { ChatService } from './chat-service'
import { RemoteService } from './remote-service'

// No OS keychain in tests: secrets fall back to plain storage.
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

function setup() {
  const store = new Store(openDatabase(':memory:'), 'dev')
  const p = store.createProvider({
    name: 'p',
    baseUrl: 'http://x',
    type: 'auto',
    keyRef: `plain:${Buffer.from('sk').toString('base64')}`,
  })
  store.syncModels(p.id, [
    { id: 'chat-a', capabilities: ['chat', 'reasoning'] },
    { id: 'chat-b', capabilities: ['chat'] },
    { id: 'img', capabilities: ['image'] },
  ])
  const models = store.listAvailableModels()
  const id = (modelId: string) => models.find((m) => m.modelId === modelId)!.id
  const modeChanges: string[] = []
  const invalidated: string[] = []
  const chat = {
    projectModeChanged: (pid: string) => modeChanges.push(pid),
    runningConversations: () => [],
    pendingApprovals: () => [],
  } as unknown as ChatService
  const svc = new RemoteService(
    store,
    chat,
    {} as BlobStore,
    () => {},
    () => {},
    () => ({ defaultModelId: id('chat-b'), defaultThinking: 'low' }),
    (scope) => invalidated.push(scope),
  )
  const rpc = (method: string, params?: unknown) =>
    (svc as unknown as { handleRpc: (m: string, p: unknown) => Promise<unknown> }).handleRpc(
      method,
      params,
    )
  return { store, rpc, id, modeChanges, invalidated }
}

describe('RemoteService remote API', () => {
  it('starts phone conversations on the desktop defaults', async () => {
    const { rpc, id } = setup()
    expect(await rpc('conversation.create', {})).toMatchObject({
      modelId: id('chat-b'),
      thinking: 'low',
    })
  })

  it('lets the phone change model and thinking, but only to usable values', async () => {
    const { store, rpc, id, invalidated } = setup()
    const conv = store.createConversation({ projectId: null, modelId: id('chat-b') })

    const updated = await rpc('conversation.update', {
      id: conv.id,
      modelId: id('chat-a'),
      thinking: 'high',
    })
    expect(updated).toMatchObject({ modelId: id('chat-a'), thinking: 'high' })
    expect(invalidated).toContain('conversations')

    await expect(rpc('conversation.update', { id: conv.id, modelId: id('img') })).rejects.toThrow(
      '模型不可用',
    )
    await expect(rpc('conversation.update', { id: conv.id, thinking: 'max' })).rejects.toThrow(
      '无效的思考强度',
    )
  })

  it('lets the phone set any project permission mode', async () => {
    const { store, rpc, modeChanges } = setup()
    const project = store.createProject({ name: 'p', rootPath: '/tmp/p' })

    expect(await rpc('project.setMode', { projectId: project.id, mode: 'plan' })).toMatchObject({
      permissionMode: 'plan',
    })
    expect(modeChanges).toEqual([project.id])
    await rpc('project.setMode', { projectId: project.id, mode: 'auto' })
    expect(store.getProject(project.id)?.permissionMode).toBe('auto')
    await expect(rpc('project.setMode', { projectId: project.id, mode: 'yolo' })).rejects.toThrow(
      '无效的权限模式',
    )
    expect(await rpc('sync')).toMatchObject({ remoteModes: ['ask', 'auto-edit', 'auto', 'plan'] })
  })
})
