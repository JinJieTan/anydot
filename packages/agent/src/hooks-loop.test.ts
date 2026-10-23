import { startMockServer, type MockServer } from '@aitech/core/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HookEvent, Hooks } from './hooks'
import { runAgent, type AgentEvent } from './loop'
import { ALL_TOOLS } from './tools'

let server: MockServer
beforeAll(async () => {
  server = await startMockServer({
    reply: (r) => {
      if (r.lastUserText.includes('Stop hook')) return { text: 'fixed the tests' }
      if (r.toolResults.length === 0)
        return { toolCalls: [{ name: 'read_file', input: { path: 'x.txt' } }] }
      return { text: 'done' }
    },
  })
})
afterAll(() => server.close())

describe('hooks in the loop', () => {
  it('a PreToolUse block skips the call; a Stop block sends the agent back once', async () => {
    const seen: HookEvent[] = []
    let stops = 0
    const hooks = {
      run: async (event: HookEvent) => {
        seen.push(event)
        if (event === 'PreToolUse') return { block: 'not allowed', notes: [] }
        if (event === 'Stop' && stops++ === 0) return { block: 'tests fail', notes: [] }
        return { notes: [] }
      },
    } as unknown as Hooks
    const events: AgentEvent[] = []
    const res = await runAgent({
      model: {
        provider: { baseUrl: server.url, apiKey: 'sk-test', type: 'auto' },
        modelId: 'claude-sonnet-5-5',
      },
      messages: [{ role: 'user', content: 'go' }],
      tools: ALL_TOOLS,
      ctx: {
        cwd: '/tmp',
        signal: new AbortController().signal,
        platform: process.platform,
        env: process.env,
        readFiles: new Map(),
      },
      mode: 'auto',
      hooks,
      onEvent: (e) => events.push(e),
      approve: async () => 'allow',
    })
    expect(res.status).toBe('done')
    const result = events.find((e) => e.type === 'tool-result')
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('not allowed') })
    expect(seen).toEqual(['PreToolUse', 'Stop', 'Stop'])
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toContain('fixed the tests')
  })
})
