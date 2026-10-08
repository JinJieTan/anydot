/**
 * A tiny local gateway speaking the four protocols we use, for tests and for
 * running the app without a real key. Not a faithful reimplementation; just
 * enough wire format for the AI SDK parsers.
 *
 *   GET  /v1/models
 *   POST /v1/messages            (Anthropic, streaming)
 *   POST /v1/responses           (OpenAI Responses, streaming)
 *   POST /v1/chat/completions    (OpenAI Chat, streaming)
 *   POST /v1/images/generations | /v1/images/edits
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockReply {
  text?: string
  reasoning?: string
  toolCalls?: { name: string; input: unknown }[]
}

export interface MockRequestInfo {
  path: string
  body: unknown
  headers: IncomingMessage['headers']
  /** Last user message text, flattened. */
  lastUserText: string
  /** Tool results sent back by the client, in order (any protocol). */
  toolResults: string[]
}

export interface MockServerOptions {
  apiKey?: string
  models?: string[]
  reply?: (req: MockRequestInfo) => MockReply
  /** Delay between streamed events, to make streaming (and stopping) observable. */
  delayMs?: number
}

export interface MockServer {
  url: string
  requests: MockRequestInfo[]
  close: () => Promise<void>
}

// 1x1 transparent PNG
export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const DEFAULT_MODELS = ['claude-sonnet-5-5', 'gpt-5', 'gpt-image-2']

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const apiKey = opts.apiKey ?? 'sk-test'
  const reply = opts.reply ?? ((r) => ({ text: `Echo: ${r.lastUserText}` }))
  const requests: MockRequestInfo[] = []
  streamDelay = opts.delayMs ?? 0

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0]!
    const key =
      req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
    if (key !== apiKey) return json(res, 401, { error: { message: 'invalid api key' } })

    if (req.method === 'GET' && path === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: (opts.models ?? DEFAULT_MODELS).map((id) => ({ id, object: 'model' })),
      })
    }

    const raw = await readBody(req)
    const isJson = (req.headers['content-type'] ?? '').includes('application/json')
    const body = isJson ? (JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>) : {}
    const info: MockRequestInfo = {
      path,
      body: isJson ? body : raw.toString('latin1'),
      headers: req.headers,
      lastUserText: lastUserText(body),
      toolResults: toolResults(body),
    }
    requests.push(info)

    if (path === '/v1/images/generations' || path === '/v1/images/edits') {
      const n = Number((body as { n?: number }).n ?? 1)
      return json(res, 200, {
        created: 0,
        data: Array.from({ length: n }, () => ({ b64_json: TINY_PNG_B64 })),
        usage: { input_tokens: 10, output_tokens: 100 },
      })
    }

    const r = reply(info)
    if (path === '/v1/messages') return streamAnthropic(res, String(body.model), r)
    if (path === '/v1/responses') return streamResponses(res, String(body.model), r)
    if (path === '/v1/chat/completions') return streamChat(res, String(body.model), r)
    json(res, 404, { error: { message: `no route ${path}` } })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

let streamDelay = 0
let callSeq = 0

/**
 * SSE writer. Events are queued and flushed with `streamDelay` between them;
 * flushing stops early if the client disconnects (e.g. the user hit stop).
 */
function sse(res: ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const queue: string[] = []
  const send = (event: string | null, data: unknown) => {
    queue.push(
      `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    )
  }
  const end = async () => {
    for (const chunk of queue) {
      if (res.destroyed) return
      res.write(chunk)
      if (streamDelay) await new Promise((r) => setTimeout(r, streamDelay))
    }
    res.end()
  }
  return Object.assign(send, { end })
}

/** Split text into a few chunks so streaming is actually exercised. */
function chunks(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += 4) out.push(text.slice(i, i + 4))
  return out
}

function lastUserText(body: Record<string, unknown>): string {
  const flatten = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (Array.isArray(content))
      return content
        .map((c: { type?: string; text?: string }) =>
          c.type === 'text' || c.type === 'input_text' ? (c.text ?? '') : '',
        )
        .join('')
    return ''
  }
  const list = (body.messages ?? body.input) as { role?: string; content?: unknown }[] | undefined
  if (!Array.isArray(list)) return ''
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') return flatten(list[i]!.content)
  }
  return ''
}

function toolResults(body: Record<string, unknown>): string[] {
  const out: string[] = []
  const str = (v: unknown) =>
    typeof v === 'string'
      ? v
      : Array.isArray(v)
        ? v.map((c: { text?: string }) => c.text ?? '').join('')
        : JSON.stringify(v)
  for (const m of (body.messages ?? body.input ?? []) as Record<string, unknown>[]) {
    if (m.type === 'function_call_output') out.push(str(m.output)) // OpenAI Responses
    if (m.role === 'tool') out.push(str(m.content)) // OpenAI Chat
    if (Array.isArray(m.content)) {
      for (const c of m.content as Record<string, unknown>[]) {
        if (c.type === 'tool_result') out.push(str(c.content)) // Anthropic
      }
    }
  }
  return out
}

function streamAnthropic(res: ServerResponse, model: string, r: MockReply) {
  const send = sse(res)
  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 0 },
    },
  })
  let index = 0
  if (r.reasoning) {
    send('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
    for (const c of chunks(r.reasoning))
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: c },
      })
    send('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'signature_delta', signature: 'mock-signature' },
    })
    send('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  if (r.text) {
    send('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
    for (const c of chunks(r.text))
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: c },
      })
    send('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  for (const call of r.toolCalls ?? []) {
    send('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `toolu_${++callSeq}`, name: call.name, input: {} },
    })
    send('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    })
    send('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: r.toolCalls?.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 7 },
  })
  send('message_stop', { type: 'message_stop' })
  void send.end()
}

function streamResponses(res: ServerResponse, model: string, r: MockReply) {
  const send = sse(res)
  let seq = 0
  const ev = (data: Record<string, unknown>) => send(null, { ...data, sequence_number: seq++ })
  ev({ type: 'response.created', response: { id: 'resp_mock', created_at: 0, model } })
  let out = 0
  if (r.text) {
    const item = {
      type: 'message',
      id: 'msg_mock',
      role: 'assistant',
      status: 'in_progress',
      content: [],
    }
    ev({ type: 'response.output_item.added', output_index: out, item })
    for (const c of chunks(r.text))
      ev({
        type: 'response.output_text.delta',
        item_id: 'msg_mock',
        output_index: out,
        content_index: 0,
        delta: c,
      })
    ev({
      type: 'response.output_item.done',
      output_index: out,
      item: {
        ...item,
        status: 'completed',
        content: [{ type: 'output_text', text: r.text, annotations: [] }],
      },
    })
    out++
  }
  for (const call of r.toolCalls ?? []) {
    const args = JSON.stringify(call.input)
    const n = ++callSeq
    const item = {
      type: 'function_call',
      id: `fc_${n}`,
      call_id: `call_${n}`,
      name: call.name,
      arguments: '',
    }
    ev({ type: 'response.output_item.added', output_index: out, item })
    ev({
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: out,
      delta: args,
    })
    ev({
      type: 'response.output_item.done',
      output_index: out,
      item: { ...item, arguments: args, status: 'completed' },
    })
    out++
  }
  ev({
    type: 'response.completed',
    response: {
      id: 'resp_mock',
      created_at: 0,
      model,
      status: 'completed',
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 19,
      },
    },
  })
  void send.end()
}

function streamChat(res: ServerResponse, model: string, r: MockReply) {
  const send = sse(res)
  const base = { id: 'chatcmpl_mock', object: 'chat.completion.chunk', created: 0, model }
  send(null, {
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  })
  for (const c of chunks(r.text ?? ''))
    send(null, { ...base, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })
  for (const [i, call] of (r.toolCalls ?? []).entries())
    send(null, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                id: `call_${++callSeq}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
  send(null, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: r.toolCalls?.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  })
  send(null, '[DONE]')
  void send.end()
}
