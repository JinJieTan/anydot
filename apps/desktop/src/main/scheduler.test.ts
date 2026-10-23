import { openDatabase, Store } from '@aitech/db'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/ipc'
import type { ChatService } from './chat-service'
import { Scheduler } from './scheduler'

function setup() {
  let now = new Date('2026-10-23T08:59:30').getTime()
  const store = new Store(openDatabase(':memory:'), 'dev-1')
  const sent: { conversationId: string; text: string }[] = []
  const running: string[] = []
  const chat = {
    send: async (conversationId: string, text: string) => {
      sent.push({ conversationId, text })
    },
    runningConversations: () => running,
  } as unknown as ChatService
  let changes = 0
  const scheduler = new Scheduler(
    store,
    chat,
    () => DEFAULT_SETTINGS,
    () => changes++,
    () => now,
  )
  return {
    store,
    scheduler,
    sent,
    running,
    advance: (ms: number) => (now += ms),
    changes: () => changes,
  }
}

describe('Scheduler', () => {
  it('starts a conversation when a schedule is due, then plans the next run', async () => {
    const { store, scheduler, sent, advance } = setup()
    const s = scheduler.create({
      name: ' Morning ',
      projectId: null,
      prompt: 'summarise the news',
      cron: '0  9 * * *',
      modelId: null,
    })
    expect(s.name).toBe('Morning')
    expect(s.cron).toBe('0 9 * * *')
    expect(new Date(s.nextRunAt!).toString()).toBe(new Date('2026-10-23T09:00:00').toString())

    await scheduler.tick()
    expect(sent).toEqual([])

    advance(60_000)
    await scheduler.tick()
    expect(sent.map((x) => x.text)).toEqual(['summarise the news'])
    const after = store.getSchedule(s.id)!
    expect(after.lastConversationId).toBe(sent[0]!.conversationId)
    expect(store.getConversation(sent[0]!.conversationId)!.title).toBe('⏰ Morning')
    expect(new Date(after.nextRunAt!).toString()).toBe(new Date('2026-10-24T09:00:00').toString())

    // Not due again until tomorrow.
    await scheduler.tick()
    expect(sent).toHaveLength(1)
  })

  it('skips a run while the previous one is still going, and honours disabling', async () => {
    const { scheduler, sent, running, advance } = setup()
    const s = scheduler.create({
      name: 'x',
      projectId: null,
      prompt: 'p',
      cron: '* * * * *',
      modelId: null,
    })
    advance(60_000)
    await scheduler.tick()
    expect(sent).toHaveLength(1)
    running.push(sent[0]!.conversationId)
    advance(60_000)
    await scheduler.tick()
    expect(sent).toHaveLength(1)
    running.length = 0
    scheduler.update(s.id, { enabled: false })
    advance(60_000)
    await scheduler.tick()
    expect(sent).toHaveLength(1)
    expect(await scheduler.runNow(s.id)).toBeTruthy()
    expect(sent).toHaveLength(2)
  })

  it('validates input and records failures', async () => {
    const { store, scheduler } = setup()
    expect(() =>
      scheduler.create({ name: 'x', projectId: null, prompt: 'p', cron: 'bad', modelId: null }),
    ).toThrow(/5 个字段/)
    expect(() =>
      scheduler.create({
        name: '',
        projectId: null,
        prompt: 'p',
        cron: '* * * * *',
        modelId: null,
      }),
    ).toThrow(/名称/)
    const p = store.createProject({ name: 'gone', rootPath: '/definitely/not/here' })
    const s = scheduler.create({
      name: 'x',
      projectId: p.id,
      prompt: 'p',
      cron: '* * * * *',
      modelId: null,
    })
    await expect(scheduler.runNow(s.id)).rejects.toThrow(/项目文件夹不存在/)
    expect(store.getSchedule(s.id)!.lastError).toMatch(/项目文件夹不存在/)
  })
})
