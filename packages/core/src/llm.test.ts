import { jsonSchema, tool } from 'ai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateImages } from './images'
import { createVideo, downloadVideo, waitForVideo } from './videos'
import {
  defineTools,
  nativeComputerTool,
  withCacheBreakpoints,
  streamChat,
  toModelMessages,
  type ChatEvent,
  type ModelRef,
} from './llm'
import type { StoredMessage } from './messages'
import { listModels } from './models'
import { startMockServer, type MockServer } from './testing/mock-server'

let server: MockServer

beforeAll(async () => {
  server = await startMockServer({
    reply: (r) => {
      if (r.lastUserText === 'think') return { reasoning: 'hmm', text: 'done' }
      if (r.lastUserText === 'tool')
        return { toolCalls: [{ name: 'get_time', input: { tz: 'UTC' } }] }
      return { text: `Echo: ${r.lastUserText}` }
    },
  })
})
afterAll(() => server.close())

const ref = (modelId: string, protocol?: ModelRef['protocol'], apiKey = 'sk-test'): ModelRef => ({
  provider: { baseUrl: server.url, apiKey, type: 'auto' },
  modelId,
  protocol,
})

async function collect(gen: AsyncGenerator<ChatEvent>) {
  const events: ChatEvent[] = []
  for await (const e of gen) events.push(e)
  const text = events.map((e) => (e.type === 'text' ? e.text : '')).join('')
  const reasoning = events.map((e) => (e.type === 'reasoning' ? e.text : '')).join('')
  return { events, text, reasoning }
}

const user = (text: string) => [{ role: 'user' as const, content: text }]

describe('streamChat', () => {
  it.each([
    ['claude-sonnet-5-5', undefined, '/v1/messages'],
    ['gpt-5', undefined, '/v1/responses'],
    ['gpt-5', 'openai-chat' as const, '/v1/chat/completions'],
  ])('%s via %s streams text', async (model, protocol, path) => {
    const before = server.requests.length
    const { text, events } = await collect(
      streamChat({ model: ref(model, protocol), messages: user('hello world') }),
    )
    expect(text).toBe('Echo: hello world')
    expect(server.requests[before]?.path).toBe(path)
    const finish = events.find((e) => e.type === 'finish')
    expect(finish).toMatchObject({ type: 'finish', usage: { inputTokens: 12, outputTokens: 7 } })
  })

  it('surfaces reasoning from Claude', async () => {
    const { text, reasoning } = await collect(
      streamChat({ model: ref('claude-sonnet-5-5'), messages: user('think'), thinking: 'low' }),
    )
    expect(reasoning).toBe('hmm')
    expect(text).toBe('done')
  })

  it('sends thinking options to Anthropic', async () => {
    const before = server.requests.length
    await collect(
      streamChat({ model: ref('claude-sonnet-5-5'), messages: user('x'), thinking: 'high' }),
    )
    const body = server.requests[before]!.body as { thinking?: { type: string } }
    expect(body.thinking?.type).toBe('adaptive')
  })

  it.each([
    ['claude-sonnet-5-5', undefined],
    ['gpt-5', undefined],
    ['gpt-5', 'openai-chat' as const],
  ])('%s %s emits tool calls without executing them', async (model, protocol) => {
    const tools = {
      get_time: tool({
        description: 'current time',
        inputSchema: jsonSchema<{ tz: string }>({
          type: 'object',
          properties: { tz: { type: 'string' } },
          required: ['tz'],
        }),
      }),
    }
    const { events } = await collect(
      streamChat({ model: ref(model, protocol), messages: user('tool'), tools }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-call', name: 'get_time', input: { tz: 'UTC' } }),
    )
  })

  it('reports a readable error for a bad key', async () => {
    const { events } = await collect(
      streamChat({ model: ref('gpt-5', undefined, 'wrong'), messages: user('x') }),
    )
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    expect((err as { message: string }).message).toMatch(/401/)
  })

  it('refuses image models', async () => {
    const { events } = await collect(streamChat({ model: ref('gpt-image-2'), messages: user('x') }))
    expect(events[0]).toMatchObject({ type: 'error' })
  })
})

describe('prompt caching', () => {
  const cacheOf = (m: { providerOptions?: unknown }) =>
    (m.providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined)?.anthropic
      ?.cacheControl

  it('marks the system prompt, the previous request end and the last message', () => {
    const history = [
      { role: 'user' as const, content: 'go' },
      { role: 'assistant' as const, content: 'step 1' },
      { role: 'user' as const, content: 'more' },
      { role: 'assistant' as const, content: 'step 2' },
      { role: 'user' as const, content: 'last' },
    ]
    const { messages, system } = withCacheBreakpoints(history, 'SYS')
    expect(system).toMatchObject({ role: 'system', content: 'SYS' })
    expect(cacheOf(system!)).toBeTruthy()
    expect(messages.map((m) => !!cacheOf(m))).toEqual([false, false, true, false, true])
    // The caller's history is left untouched.
    expect(history.some((m) => 'providerOptions' in m)).toBe(false)
  })

  it('sends cache_control to Anthropic but not to OpenAI', async () => {
    const before = server.requests.length
    await collect(
      streamChat({ model: ref('claude-sonnet-5-5'), system: 'SYS', messages: user('hi') }),
    )
    await collect(streamChat({ model: ref('gpt-5'), system: 'SYS', messages: user('hi') }))
    const [claude, gpt] = server.requests.slice(before).map((r) => JSON.stringify(r.body))
    expect(claude).toMatch(
      /"system":\[\{"type":"text","text":"SYS","cache_control":\{"type":"ephemeral"\}\}\]/,
    )
    expect(claude).toMatch(/"text":"hi","cache_control":\{"type":"ephemeral"\}/)
    expect(gpt).not.toMatch(/cache_control/)
  })
})

describe('nativeComputerTool', () => {
  const official = (modelId: string, baseUrl = 'https://api.anthropic.com'): ModelRef => ({
    provider: { baseUrl, apiKey: 'k', type: 'anthropic' },
    modelId,
  })
  const display = { width: 1280, height: 800 }

  it('is used only on the official Anthropic API with a trained model', () => {
    expect(nativeComputerTool(official('claude-opus-5-5'), display)).not.toBeNull()
    expect(nativeComputerTool(official('claude-opus-4-5'), display)).not.toBeNull()
    expect(
      nativeComputerTool(official('claude-opus-5-5', 'https://relay.example'), display),
    ).toBeNull()
    expect(nativeComputerTool(official('claude-3-haiku'), display)).toBeNull()
    expect(
      nativeComputerTool(
        {
          ...official('gpt-5'),
          provider: { baseUrl: 'https://api.openai.com', apiKey: 'k', type: 'openai' },
        },
        display,
      ),
    ).toBeNull()
  })

  it.each([
    ['claude-opus-5-5', /"type":"computer_toolset_20260801"/],
    ['claude-opus-4-5', /"type":"computer_20251124".*"display_width_px":1280/],
  ])('%s sends the provider tool definition', async (modelId, pattern) => {
    const native = nativeComputerTool(official(modelId), display)!
    const before = server.requests.length
    await collect(
      streamChat({
        model: ref(modelId),
        messages: user('hi'),
        tools: defineTools([
          { name: 'computer', description: '', inputSchema: {}, provider: native },
        ]),
      }),
    )
    const req = server.requests.slice(before).at(-1)!
    expect(JSON.stringify(req.body)).toMatch(pattern)
  })
})

describe('listModels', () => {
  it('lists and classifies models', async () => {
    const models = await listModels(server.url, 'sk-test')
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'gpt-5', 'gpt-image-2', 'sora-2'])
    expect(models.find((m) => m.id === 'sora-2')?.capabilities).toEqual(['video'])
    expect(models.find((m) => m.id === 'gpt-image-2')?.capabilities).toEqual(['image'])
    expect(models.find((m) => m.id === 'gpt-5')?.capabilities).toContain('vision')
  })

  it('throws on a bad key', async () => {
    await expect(listModels(server.url, 'nope')).rejects.toThrow(/401/)
  })
})

describe('generateImages', () => {
  it('generates images', async () => {
    const res = await generateImages({
      baseUrl: server.url,
      apiKey: 'sk-test',
      model: 'gpt-image-2',
      prompt: 'a cat',
      n: 2,
    })
    expect(res.images).toHaveLength(2)
    expect(res.images[0]!.mime).toBe('image/png')
    expect(res.images[0]!.data[1]).toBe(0x50) // 'P' of PNG magic
    expect(server.requests.at(-1)?.path).toBe('/v1/images/generations')
  })

  it('edits with reference images via multipart', async () => {
    const res = await generateImages({
      baseUrl: server.url,
      apiKey: 'sk-test',
      model: 'gpt-image-2',
      prompt: 'make it blue',
      images: [{ data: new Uint8Array([1, 2, 3]), mime: 'image/png', name: 'ref.png' }],
    })
    expect(res.images).toHaveLength(1)
    const last = server.requests.at(-1)!
    expect(last.path).toBe('/v1/images/edits')
    expect(String(last.body)).toContain('name="image[]"; filename="ref.png"')
    expect(String(last.body)).toContain('make it blue')
  })
})

describe('response event', () => {
  it('returns replayable assistant messages including tool calls', async () => {
    const tools = defineTools([
      { name: 'get_time', description: 'now', inputSchema: { type: 'object', properties: {} } },
    ])
    const { events } = await collect(
      streamChat({ model: ref('claude-sonnet-5-5'), messages: user('tool'), tools }),
    )
    const res = events.find((e) => e.type === 'response') as Extract<
      ChatEvent,
      { type: 'response' }
    >
    expect(res.messages[0]).toMatchObject({
      role: 'assistant',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'tool-call', toolName: 'get_time' }),
      ]),
    })
  })

  it('lets the mock see tool results on the next request', async () => {
    const before = server.requests.length
    await collect(
      streamChat({
        model: ref('gpt-5'),
        messages: [
          { role: 'user', content: 'tool' },
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'get_time', input: {} }],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c1',
                toolName: 'get_time',
                output: { type: 'text', value: '12:00' },
              },
            ],
          },
        ],
        tools: defineTools([
          { name: 'get_time', description: 'now', inputSchema: { type: 'object', properties: {} } },
        ]),
      }),
    )
    expect(server.requests[before]!.toolResults).toEqual(['12:00'])
  })
})

describe('videos', () => {
  it('creates, polls and downloads a video', async () => {
    const opts = { baseUrl: server.url, apiKey: 'sk-test' }
    const job = await createVideo({
      ...opts,
      model: 'sora-2',
      prompt: 'a cat',
      seconds: '4',
      size: '1280x720',
    })
    expect(job.status).toBe('queued')
    const progress: number[] = []
    const done = await waitForVideo({ ...opts, id: job.id, intervalMs: 10 }, (j) =>
      progress.push(j.progress ?? 0),
    )
    expect(done.status).toBe('completed')
    expect(progress).toEqual([0, 40, 100])
    const file = await downloadVideo({ ...opts, id: job.id })
    expect(file.mime).toBe('video/mp4')
    expect(new TextDecoder().decode(file.data.slice(4, 8))).toBe('ftyp')
  })

  it('reports API errors', async () => {
    await expect(
      downloadVideo({ baseUrl: server.url, apiKey: 'sk-test', id: 'nope' }),
    ).rejects.toThrow(/404/)
  })
})

describe('toModelMessages', () => {
  const msg = (role: StoredMessage['role'], parts: StoredMessage['parts']): StoredMessage => ({
    id: role,
    conversationId: 'c',
    parentId: null,
    role,
    parts,
    status: 'complete',
    createdAt: 0,
  })

  it('maps parts and inlines text files', async () => {
    const blobs: Record<string, Uint8Array> = {
      img: new Uint8Array([9]),
      txt: new TextEncoder().encode('a,b'),
      pdf: new Uint8Array([7]),
    }
    const out = await toModelMessages(
      [
        msg('user', [
          { type: 'text', text: 'see' },
          { type: 'image', blob: 'img', mime: 'image/png' },
          { type: 'file', blob: 'txt', mime: 'text/csv', name: 'd.csv' },
          { type: 'file', blob: 'pdf', mime: 'application/pdf', name: 'r.pdf' },
        ]),
        msg('assistant', [
          { type: 'reasoning', text: 'internal' },
          { type: 'text', text: 'ok' },
        ]),
      ],
      async (sha) => blobs[sha]!,
    )
    expect(out[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image', mediaType: 'image/png' },
        { type: 'text', text: '<file name="d.csv">\na,b\n</file>' },
        { type: 'file', mediaType: 'application/pdf', filename: 'r.pdf' },
      ],
    })
    // reasoning is display-only and never replayed
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
  })

  it('sends only the most recent tool screenshots', async () => {
    const steps = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((id) => [
      msg('assistant', [{ type: 'tool_call', id, name: 'computer', input: {} }]),
      msg('tool', [
        {
          type: 'tool_result',
          id,
          name: 'computer',
          output: `shot ${id}`,
          images: [{ blob: id, mime: 'image/jpeg' }],
        },
      ]),
    ])
    const loaded: string[] = []
    const out = await toModelMessages(
      steps,
      async (sha) => (loaded.push(sha), new Uint8Array([1])),
      // 7 screenshots, keep 2: the cut-off moves in steps of 4, so 4 are dropped.
      { keepRecentImages: 2 },
    )
    const outputs = out.flatMap((m) =>
      m.role === 'tool' ? m.content.map((c) => (c.type === 'tool-result' ? c.output : null)) : [],
    )
    expect(outputs[0]).toEqual({
      type: 'text',
      value: 'shot a\n[screenshot omitted to save context]',
    })
    expect(outputs[3]).toMatchObject({ type: 'text' })
    expect(outputs[4]).toMatchObject({
      type: 'content',
      value: [
        { type: 'text', text: 'shot e' },
        { type: 'file', mediaType: 'image/jpeg' },
      ],
    })
    expect(loaded.sort()).toEqual(['e', 'f', 'g'])
  })

  it('merges consecutive tool messages and patches interrupted calls', async () => {
    const call = (id: string) => ({ type: 'tool_call' as const, id, name: 'bash', input: {} })
    const result = (id: string, output: string) => ({
      type: 'tool_result' as const,
      id,
      name: 'bash',
      output,
    })
    const out = await toModelMessages(
      [
        msg('user', [{ type: 'text', text: 'go' }]),
        msg('assistant', [call('a'), call('b')]),
        msg('tool', [result('a', 'A')]),
        msg('tool', [result('b', 'B')]),
        msg('assistant', [call('c')]),
        // run interrupted: no result for c
        msg('user', [{ type: 'text', text: 'next' }]),
      ],
      async () => new Uint8Array(),
    )
    expect(out.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'user',
    ])
    expect((out[2] as { content: unknown[] }).content).toHaveLength(2)
    expect(out[4]).toMatchObject({
      role: 'tool',
      content: [{ toolCallId: 'c', output: { type: 'error-text' } }],
    })
  })

  it('truncates old tool output but keeps recent ones intact', async () => {
    const long = 'x'.repeat(100)
    const out = await toModelMessages(
      [
        msg('assistant', [{ type: 'tool_call', id: '1', name: 't', input: {} }]),
        msg('tool', [{ type: 'tool_result', id: '1', name: 't', output: long }]),
        msg('assistant', [{ type: 'tool_call', id: '2', name: 't', input: {} }]),
        msg('tool', [{ type: 'tool_result', id: '2', name: 't', output: long }]),
      ],
      async () => new Uint8Array(),
      { maxOldToolResultChars: 10, keepRecentToolResults: 1 },
    )
    const value = (i: number) =>
      (out[i] as { content: { output: { value: string } }[] }).content[0]!.output.value
    expect(value(1)).toMatch(/^x{10}\n…\[truncated 90 chars\]$/)
    expect(value(3)).toBe(long)
  })

  it('starts from the latest compaction summary', async () => {
    const out = await toModelMessages(
      [
        msg('user', [{ type: 'text', text: 'old request' }]),
        msg('assistant', [{ type: 'text', text: 'old answer' }]),
        msg('system', [{ type: 'summary', text: 'S1' }]),
        msg('assistant', [{ type: 'text', text: 'continuing' }]),
      ],
      async () => new Uint8Array(),
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<conversation_summary>\nS1'),
    })
    expect(out[1]).toMatchObject({ role: 'assistant' })
  })
})
