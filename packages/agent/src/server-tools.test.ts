import { startMockServer, type MockServer } from '@aitech/core/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nativeWebSearchTool } from '@aitech/core'
import { runAgent, type AgentEvent } from './loop'
import { webSearchTool } from './tools'

let server: MockServer

beforeAll(async () => {
  server = await startMockServer({
    reply: (r) => {
      const body = JSON.stringify(r.body)
      // First request: search, then pause. Second (continuation): answer.
      if (!body.includes('web_search_tool_result'))
        return {
          serverSearch: {
            query: 'electron utilityProcess',
            results: [
              { url: 'https://electronjs.org/docs/api/utility-process', title: 'utilityProcess' },
            ],
          },
          stopReason: 'pause_turn',
        }
      return { text: 'It is a Node child process.' }
    },
  })
})
afterAll(() => server.close())

describe('provider-run tools', () => {
  it('are shown, never executed, and a paused turn continues', async () => {
    const events: AgentEvent[] = []
    // The tool object is the same for any endpoint; only its selection checks the host.
    const native = nativeWebSearchTool({
      provider: { baseUrl: 'https://api.anthropic.com', apiKey: 'k', type: 'anthropic' },
      modelId: 'claude-sonnet-5-5',
    })!
    const tool = { ...webSearchTool, definition: { ...webSearchTool.definition, provider: native } }
    const result = await runAgent({
      model: {
        provider: { baseUrl: server.url, apiKey: 'sk-test', type: 'anthropic' },
        modelId: 'claude-sonnet-5-5',
      },
      messages: [{ role: 'user', content: 'what is utilityProcess?' }],
      tools: [tool as never],
      mode: 'ask',
      ctx: {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        platform: process.platform,
        env: process.env,
        readFiles: new Map(),
        // No host: the client-side search would fail if it were run.
      },
      onEvent: (e) => events.push(e),
      approve: async () => {
        throw new Error('server tools must not ask for approval')
      },
    })
    expect(result).toMatchObject({ status: 'done', steps: 2 })

    const first = events.find((e) => e.type === 'step-end')
    expect(first).toMatchObject({
      parts: [
        {
          type: 'tool_call',
          name: 'web_search',
          server: true,
          input: { query: 'electron utilityProcess' },
        },
      ],
    })
    const shown = events.find((e) => e.type === 'tool-result')
    expect(shown).toMatchObject({ name: 'web_search', isError: false })
    expect((shown as { output: string }).output).toContain(
      'https://electronjs.org/docs/api/utility-process',
    )

    const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')
    expect(text).toBe('It is a Node child process.')
    // The tool was declared as Anthropic's server tool, not as a function.
    expect(JSON.stringify(server.requests.at(-1)!.body)).toMatch(/"type":"web_search_20250305"/)
  })
})
