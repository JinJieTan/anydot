import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessagePart } from '@aitech/core'
import { openDatabase, Store } from '@aitech/db'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/ipc'
import type { AgentHost } from './agent-host'
import { BlobStore } from './blobs'
import { ChatService } from './chat-service'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aitech-rewind-'))
  dirs.push(dir)
  const store = new Store(openDatabase(':memory:'), 'dev')
  const blobs = new BlobStore(join(dir, 'blobs'), store)
  const chat = new ChatService(
    store,
    blobs,
    {} as AgentHost,
    () => DEFAULT_SETTINGS,
    () => {},
  )
  const conv = store.createConversation({ title: 't' })
  let leaf: string | null = null
  const add = (role: 'user' | 'assistant' | 'tool', parts: MessagePart[]) => {
    const m = store.addMessage({ conversationId: conv.id, parentId: leaf, role, parts })
    leaf = m.id
    store.updateConversation(conv.id, { activeLeafId: m.id })
    return m
  }
  const backup = async (path: string, content: string | null) => ({
    path,
    blob: content === null ? null : await blobs.put(new TextEncoder().encode(content), 'x'),
  })
  const toolResult = (backups: { path: string; blob: string | null }[]): MessagePart => ({
    type: 'tool_result',
    id: 'c',
    name: 'edit_file',
    output: 'ok',
    backups,
  })
  return { dir, chat, conv, add, backup, toolResult }
}

describe('rewindFiles', () => {
  it('restores files to their state at a user message and deletes created ones', async () => {
    const { dir, chat, conv, add, backup, toolResult } = await setup()
    const a = join(dir, 'a.txt')
    const created = join(dir, 'new.txt')
    const untouched = join(dir, 'earlier.txt')

    add('user', [{ type: 'text', text: 'first' }])
    add('tool', [toolResult([await backup(untouched, 'v0')])])
    const second = add('user', [{ type: 'text', text: 'second' }])
    add('tool', [toolResult([await backup(a, 'original')])]) // a: original → edit1
    add('tool', [toolResult([await backup(a, 'edit1'), await backup(created, null)])])
    writeFileSync(a, 'edit2')
    writeFileSync(created, 'made by agent')
    writeFileSync(untouched, 'v1')

    const plan = await chat.rewindFiles(conv.id, second.id, true)
    expect(plan).toEqual([
      { path: a, action: 'restore' },
      { path: created, action: 'delete' },
    ])
    expect(readFileSync(a, 'utf8')).toBe('edit2') // dry run changes nothing

    await chat.rewindFiles(conv.id, second.id, false)
    expect(readFileSync(a, 'utf8')).toBe('original')
    expect(existsSync(created)).toBe(false)
    expect(readFileSync(untouched, 'utf8')).toBe('v1') // changed before the message
  })

  it('rejects messages that are not on the active branch', async () => {
    const { chat, conv } = await setup()
    await expect(chat.rewindFiles(conv.id, 'nope', true)).rejects.toThrow(/当前分支/)
  })
})
