import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockServer, type MockServer } from '@aitech/core/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runAgent, type AgentEvent, type ApprovalRequest } from './loop'
import { ALL_TOOLS } from './tools'
import type { ToolContext } from './tools/types'

let server: MockServer
let dir: string

beforeAll(async () => {
  // Scripted model: read a file, then edit it, then report.
  server = await startMockServer({
    reply: (r) => {
      const body = r.body as { system?: unknown; instructions?: string }
      const system = JSON.stringify(body.system ?? body.instructions ?? '')
      if (system.includes('compacting')) return { text: 'SUMMARY: read hello.txt, next edit it' }
      // After compaction the model only sees the summary.
      if (r.lastUserText.includes('<conversation_summary>'))
        return { text: 'continued from summary' }
      const n = r.toolResults.length
      if (r.lastUserText === 'chat') return { text: 'just chatting' }
      if (n === 0)
        return {
          text: 'Let me look.',
          toolCalls: [{ name: 'read_file', input: { path: 'hello.txt' } }],
        }
      if (n === 1)
        return {
          toolCalls: [
            {
              name: 'edit_file',
              input: { path: 'hello.txt', old_string: 'world', new_string: 'agent' },
            },
          ],
        }
      return { text: `Done. Last result: ${r.toolResults.at(-1)}` }
    },
  })
})
afterAll(() => server.close())
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aitech-loop-'))
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (signal = new AbortController().signal): ToolContext => ({
  cwd: dir,
  signal,
  platform: process.platform,
  env: process.env,
  readFiles: new Map(),
})

function run(
  modelId: string,
  opts: {
    approve?: (r: ApprovalRequest) => 'allow' | 'deny' | 'allow-always'
    text?: string
    tools?: boolean
  } = {},
) {
  const events: AgentEvent[] = []
  const approvals: ApprovalRequest[] = []
  const promise = runAgent({
    model: { provider: { baseUrl: server.url, apiKey: 'sk-test', type: 'auto' }, modelId },
    messages: [{ role: 'user', content: opts.text ?? 'fix it' }],
    tools: opts.tools === false ? [] : ALL_TOOLS,
    ctx: ctx(),
    mode: 'ask',
    onEvent: (e) => events.push(e),
    approve: async (r) => {
      approvals.push(r)
      return opts.approve?.(r) ?? 'allow'
    },
  })
  return { promise, events, approvals }
}

describe('runAgent', () => {
  it.each(['claude-sonnet-5-5', 'gpt-5'])(
    '%s: reads, asks to edit, edits, finishes',
    async (model) => {
      const { promise, events, approvals } = await run(model)
      const res = await promise
      expect(res).toEqual({ status: 'done', steps: 3 })
      expect(approvals.map((a) => a.name)).toEqual(['edit_file'])
      expect(approvals[0]).toMatchObject({ summary: '编辑 hello.txt', danger: false })
      expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hello agent\n')

      const types = events.map((e) => e.type)
      expect(types.filter((t) => t === 'step-start')).toHaveLength(3)
      expect(types.filter((t) => t === 'tool-result')).toHaveLength(2)
      const last = events.filter((e) => e.type === 'step-end').at(-1)!
      expect(last).toMatchObject({
        parts: [{ type: 'text', text: expect.stringContaining('Edited hello.txt') }],
      })
    },
  )

  it('reports denial to the model and leaves the file alone', async () => {
    const { promise, events } = await run('gpt-5', { approve: () => 'deny' })
    expect((await promise).status).toBe('done')
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hello world\n')
    const denied = events.find((e) => e.type === 'tool-result' && e.name === 'edit_file')
    expect(denied).toMatchObject({ isError: true, output: expect.stringContaining('denied') })
  })

  it('plain chat is a single step with no tools', async () => {
    const { promise, events } = await run('claude-sonnet-5-5', { text: 'chat', tools: false })
    expect(await promise).toEqual({ status: 'done', steps: 1 })
    expect(events.at(-1)).toMatchObject({
      type: 'step-end',
      parts: [{ type: 'text', text: 'just chatting' }],
    })
  })

  it('stops between steps when aborted during approval', async () => {
    const controller = new AbortController()
    const events: AgentEvent[] = []
    const res = await runAgent({
      model: {
        provider: { baseUrl: server.url, apiKey: 'sk-test', type: 'auto' },
        modelId: 'gpt-5',
      },
      messages: [{ role: 'user', content: 'fix it' }],
      tools: ALL_TOOLS,
      ctx: ctx(controller.signal),
      mode: 'ask',
      onEvent: (e) => events.push(e),
      approve: async () => {
        controller.abort()
        return 'allow'
      },
    })
    expect(res.status).toBe('aborted')
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hello world\n')
    expect(events.at(-1)).toMatchObject({
      type: 'tool-result',
      output: expect.stringContaining('Stopped'),
    })
  })

  it('surfaces model errors', async () => {
    const res = await runAgent({
      model: { provider: { baseUrl: server.url, apiKey: 'bad', type: 'auto' }, modelId: 'gpt-5' },
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      ctx: ctx(),
      mode: 'ask',
      onEvent: () => {},
      approve: async () => 'allow',
    })
    expect(res).toMatchObject({ status: 'error', error: expect.stringContaining('401') })
  })

  it('compacts the history when input grows past the threshold', async () => {
    const events: AgentEvent[] = []
    const res = await runAgent({
      model: {
        provider: { baseUrl: server.url, apiKey: 'sk-test', type: 'auto' },
        modelId: 'claude-sonnet-5-5',
      },
      messages: [{ role: 'user', content: 'fix it' }],
      tools: ALL_TOOLS,
      ctx: ctx(),
      mode: 'auto',
      compactAtTokens: 5, // mock reports 12 input tokens per call
      onEvent: (e) => events.push(e),
      approve: async () => 'allow',
    })
    expect(res.status).toBe('done')
    expect(events).toContainEqual({
      type: 'compacted',
      summary: 'SUMMARY: read hello.txt, next edit it',
    })
    const last = events.filter((e) => e.type === 'step-end').at(-1)
    expect(last).toMatchObject({ parts: [{ type: 'text', text: 'continued from summary' }] })
  })
})
