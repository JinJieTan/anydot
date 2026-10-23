import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, Store } from '@aitech/db'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/ipc'
import type { AgentHost, RunHandlers } from './agent-host'
import { BlobStore } from './blobs'
import { ChatService } from './chat-service'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('ChatService.shutdown', () => {
  it('waits for aborted runs to save their final state, then drops late events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitech-quit-'))
    dirs.push(dir)
    const db = openDatabase(':memory:')
    const store = new Store(db, 'dev')
    const p = store.createProvider({
      name: 'p',
      baseUrl: 'http://x',
      type: 'auto',
      keyRef: `plain:${Buffer.from('sk').toString('base64')}`,
    })
    store.syncModels(p.id, [{ id: 'claude-sonnet-5-5', capabilities: ['chat'] }])

    // An agent that answers an abort only after a while, as the real process does.
    let handlers: RunHandlers | null = null
    const agent = {
      run: (_req: unknown, h: RunHandlers) => {
        handlers = h
        h.onEvent({ type: 'step-start' })
        h.onEvent({ type: 'text', text: 'partial' })
        return {
          runId: 'r',
          approve: () => {},
          abort: () =>
            setTimeout(() => {
              h.onEvent({
                type: 'step-end',
                parts: [{ type: 'text', text: 'partial' }],
                usage: null,
                finishReason: 'abort',
              })
              h.onEnd({ type: 'run.end', runId: 'r', status: 'aborted', allowed: [] })
            }, 50),
        }
      },
    } as unknown as AgentHost
    const errors: unknown[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => errors.push(args)

    const chat = new ChatService(
      store,
      new BlobStore(join(dir, 'blobs'), store),
      agent,
      () => DEFAULT_SETTINGS,
      () => {},
      join(dir, 'ws'),
    )
    const conv = store.createConversation({ title: 't' })
    await chat.send(conv.id, 'hi', [])
    await new Promise((r) => setTimeout(r, 20))
    expect(chat.runningConversations()).toEqual([conv.id])

    await chat.shutdown(2000)
    expect(chat.runningConversations()).toEqual([])
    const reply = store.listMessages(conv.id).find((m) => m.role === 'assistant')!
    expect(reply.status).toBe('aborted')
    expect(reply.parts).toEqual([{ type: 'text', text: 'partial' }])

    // The store closes; a straggler (e.g. the agent process exiting) must not touch it.
    db.close()
    handlers!.onEnd({ type: 'run.end', runId: 'r', status: 'error', error: 'exit', allowed: [] })
    await new Promise((r) => setTimeout(r, 20))
    console.error = origError
    expect(errors).toEqual([])
    await expect(chat.send(conv.id, 'again', [])).rejects.toThrow('应用正在退出')
  })

  it('returns at once when nothing is running', async () => {
    const store = new Store(openDatabase(':memory:'), 'dev')
    const chat = new ChatService(
      store,
      {} as BlobStore,
      {} as AgentHost,
      () => DEFAULT_SETTINGS,
      () => {},
    )
    const t = Date.now()
    await chat.shutdown(50)
    expect(Date.now() - t).toBeLessThan(40)
  })
})
