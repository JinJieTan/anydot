import { anthropic as anthropicProvider, createAnthropic } from '@ai-sdk/anthropic'

const anthropicTools = anthropicProvider.tools
import { createOpenAI } from '@ai-sdk/openai'
import {
  APICallError,
  jsonSchema,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type Tool,
  type ToolResultPart,
  type ToolSet,
  type UserContent,
  type AssistantContent,
} from 'ai'
import {
  isTextMime,
  type MessagePart,
  type StoredMessage,
  type ThinkingLevel,
  type Usage,
} from './messages'
import { normalizeBaseUrl, resolveProtocol, type Protocol, type ProviderType } from './provider'

export interface ProviderCredentials {
  baseUrl: string
  apiKey: string
  type: ProviderType
}

export interface ModelRef {
  provider: ProviderCredentials
  modelId: string
  /** Per-model protocol override, if the user pinned one. */
  protocol?: Protocol | null
}

export function createLanguageModel(ref: ModelRef): { model: LanguageModel; protocol: Protocol } {
  const protocol = resolveProtocol(ref.modelId, ref.provider.type, ref.protocol ?? undefined)
  const baseURL = normalizeBaseUrl(ref.provider.baseUrl)
  const apiKey = ref.provider.apiKey

  switch (protocol) {
    case 'anthropic':
      return {
        protocol,
        model: createAnthropic({
          baseURL,
          apiKey,
          // Required by Anthropic-compatible APIs when called from a browser (mobile web app).
          headers:
            'document' in globalThis
              ? { 'anthropic-dangerous-direct-browser-access': 'true' }
              : undefined,
        })(ref.modelId),
      }
    case 'openai-chat':
      return { protocol, model: createOpenAI({ baseURL, apiKey }).chat(ref.modelId) }
    case 'openai-responses':
      return { protocol, model: createOpenAI({ baseURL, apiKey }).responses(ref.modelId) }
    case 'openai-images':
      throw new Error(`${ref.modelId} 是生图模型，请在“生图”中使用`)
  }
}

/** Provider-specific knobs for extended thinking / reasoning. */
export function thinkingOptions(protocol: Protocol, level: ThinkingLevel) {
  if (level === 'off') return undefined
  switch (protocol) {
    case 'anthropic':
      return {
        anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: level },
      }
    case 'openai-responses':
      return { openai: { reasoningEffort: level, reasoningSummary: 'auto' } }
    case 'openai-chat':
      return { openai: { reasoningEffort: level } }
    default:
      return undefined
  }
}

/**
 * Responses API: never rely on server-side storage. With the SDK default
 * (`store: true`) reasoning items are replayed as `item_reference` ids, which
 * gateways / ZDR accounts that don't persist items reject with a 404. With
 * `store: false` the SDK requests `reasoning.encrypted_content` and replays it inline.
 */
function requestOptions(protocol: Protocol, level: ThinkingLevel) {
  const thinking = thinkingOptions(protocol, level)
  if (protocol !== 'openai-responses') return thinking
  return { openai: { ...thinking?.openai, store: false } }
}

export type BlobLoader = (sha256: string) => Promise<Uint8Array>

export interface ToModelMessagesOptions {
  /**
   * Tool outputs older than the most recent `keepRecentToolResults` are cut to
   * this many characters. Keeps long agent sessions inside the context window.
   */
  maxOldToolResultChars?: number
  keepRecentToolResults?: number
  /**
   * Only the most recent tool screenshots are sent (this many, up to 3 more
   * so the cut-off moves in steps); older ones become a note. Default 3.
   */
  keepRecentImages?: number
}

export interface ToolImage {
  /** Base64 or raw bytes. */
  data: string | Uint8Array
  mime: string
}

const IMAGE_OMITTED = '[screenshot omitted to save context]'

/** A tool result as the model sees it: plain text, or text plus images. */
export function toolOutput(
  text: string,
  isError: boolean,
  images: ToolImage[] = [],
): ToolResultPart['output'] {
  if (!images.length)
    return isError ? { type: 'error-text', value: text } : { type: 'text', value: text }
  return {
    type: 'content',
    value: [
      { type: 'text', text: isError ? `Error: ${text}` : text },
      ...images.map((img) => ({
        type: 'file' as const,
        mediaType: img.mime,
        data: { type: 'data' as const, data: img.data },
      })),
    ],
  }
}

const INTERRUPTED = 'Tool execution was interrupted before it produced a result.'

/**
 * Convert a stored conversation path (root → leaf) into AI SDK model messages.
 *
 * Guarantees providers accept the result: consecutive tool messages are merged
 * into one, and every tool call gets a result (an interrupted run gets a
 * synthetic error result), as Anthropic and OpenAI both require.
 */
export async function toModelMessages(
  path: StoredMessage[],
  loadBlob: BlobLoader,
  opts: ToModelMessagesOptions = {},
): Promise<ModelMessage[]> {
  const out: ModelMessage[] = []
  let pending = new Map<string, string>() // toolCallId → toolName awaiting a result

  const totalResults = path.reduce(
    (n, m) => n + m.parts.filter((p) => p.type === 'tool_result').length,
    0,
  )
  let resultIndex = 0
  const keepRecent = opts.keepRecentToolResults ?? Infinity
  const maxOld = opts.maxOldToolResultChars ?? Infinity
  // Move the truncation boundary in steps (of up to 10 results), not one by
  // one: every move rewrites earlier history and invalidates the prompt cache.
  const step = Math.max(1, Math.min(10, keepRecent))
  const truncateBelow = Number.isFinite(keepRecent)
    ? Math.floor(Math.max(0, totalResults - keepRecent) / step) * step
    : 0
  // Screenshots are large, so only the newest few are sent. Like truncation,
  // the cut-off moves in steps (of 4) to keep the cached prefix stable.
  const keepImages = opts.keepRecentImages ?? 3
  const imageIds = path.flatMap((m) =>
    m.parts.flatMap((p) => (p.type === 'tool_result' && p.images?.length ? [p.id] : [])),
  )
  const dropImages = Math.floor(Math.max(0, imageIds.length - keepImages) / 4) * 4
  const withImages = new Set(imageIds.slice(dropImages))

  const flushPending = () => {
    if (!pending.size) return
    const content = [...pending].map(([toolCallId, toolName]) => ({
      type: 'tool-result' as const,
      toolCallId,
      toolName,
      output: { type: 'error-text' as const, value: INTERRUPTED },
    }))
    const last = out.at(-1)
    if (last?.role === 'tool') last.content.push(...content)
    else out.push({ role: 'tool', content })
    pending = new Map()
  }

  // Start from the latest compaction summary, if any: it stands in for everything before it.
  const lastSummary = path.findLastIndex((m) => m.parts.some((p) => p.type === 'summary'))
  if (lastSummary > 0) path = path.slice(lastSummary)

  for (const msg of path) {
    if (msg.role !== 'tool') flushPending()

    const summary = msg.parts.find(
      (p): p is Extract<MessagePart, { type: 'summary' }> => p.type === 'summary',
    )
    if (summary) {
      out.push({ role: 'user', content: summaryPrompt(summary.text) })
      continue
    }

    if (msg.role === 'system') {
      const text = msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
      if (text) out.push({ role: 'system', content: text })
    } else if (msg.role === 'user') {
      const content: Exclude<UserContent, string> = []
      for (const part of msg.parts) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text })
        else if (part.type === 'image')
          content.push({ type: 'image', image: await loadBlob(part.blob), mediaType: part.mime })
        else if (part.type === 'file') {
          const data = await loadBlob(part.blob)
          if (isTextMime(part.mime)) {
            const body = new TextDecoder().decode(data)
            content.push({ type: 'text', text: `<file name="${part.name}">\n${body}\n</file>` })
          } else {
            content.push({ type: 'file', data, mediaType: part.mime, filename: part.name })
          }
        }
      }
      if (content.length) out.push({ role: 'user', content })
    } else if (msg.role === 'assistant') {
      const content: Exclude<AssistantContent, string> = []
      for (const part of msg.parts) {
        if (part.type === 'text' && part.text) content.push({ type: 'text', text: part.text })
        else if (part.type === 'tool_call') {
          content.push({
            type: 'tool-call',
            toolCallId: part.id,
            toolName: part.name,
            input: part.input,
          })
          pending.set(part.id, part.name)
        }
      }
      if (content.length) out.push({ role: 'assistant', content })
    } else if (msg.role === 'tool') {
      const content = []
      for (const p of msg.parts) {
        if (p.type !== 'tool_result' || !pending.delete(p.id)) continue // drop results whose call isn't in the path
        const old = resultIndex++ < truncateBelow
        let value = typeof p.output === 'string' ? p.output : JSON.stringify(p.output)
        if (old && value.length > maxOld) {
          value = `${value.slice(0, maxOld)}\n…[truncated ${value.length - maxOld} chars]`
        }
        const images: ToolImage[] = []
        if (p.images?.length) {
          if (withImages.has(p.id)) {
            for (const img of p.images)
              images.push({ data: await loadBlob(img.blob), mime: img.mime })
          } else value += `\n${IMAGE_OMITTED}`
        }
        content.push({
          type: 'tool-result' as const,
          toolCallId: p.id,
          toolName: p.name,
          output: toolOutput(value, !!p.isError, images),
        })
      }
      if (!content.length) continue
      const last = out.at(-1)
      if (last?.role === 'tool') last.content.push(...content)
      else out.push({ role: 'tool', content })
    }
  }
  flushPending()
  return out
}

/** How a compaction summary is presented to the model when the run continues. */
export function summaryPrompt(summary: string): string {
  return `<conversation_summary>\n${summary}\n</conversation_summary>\n\nThe earlier conversation was compacted into the summary above. Continue from where it left off.`
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>
  /**
   * A provider-defined tool (e.g. Anthropic's computer tool) sent instead of
   * the function definition above. Input arrives in the same shape.
   */
  provider?: Tool
}

/** Declare tools for the model without executing them (the agent loop does that). */
export function defineTools(defs: ToolDefinition[]): ToolSet {
  return Object.fromEntries(
    defs.map((d) => [
      d.name,
      d.provider ??
        tool({ description: d.description, inputSchema: jsonSchema(d.inputSchema as never) }),
    ]),
  )
}

/**
 * Anthropic's own computer-use tool, when talking to the official API with a
 * model trained for it. Gateways may not forward its beta header, so anything
 * else gets the plain function tool (same input shape) instead.
 */
export function nativeComputerTool(
  ref: ModelRef,
  display: { width: number; height: number },
): Tool | null {
  const protocol = resolveProtocol(ref.modelId, ref.provider.type, ref.protocol ?? undefined)
  if (protocol !== 'anthropic') return null
  let host: string
  try {
    host = new URL(ref.provider.baseUrl).hostname
  } catch {
    return null
  }
  if (host !== 'api.anthropic.com') return null
  const id = ref.modelId.toLowerCase()
  const size = { displayWidthPx: display.width, displayHeightPx: display.height }
  if (/^claude-(opus|sonnet|fable)-5|^claude-opus-4-8/.test(id))
    return anthropicTools.computerToolset_20260801({ configs: { zoom: { enabled: false } } })
  if (/^claude-(opus-4-[5-7]|sonnet-4-[6-9])/.test(id))
    return anthropicTools.computer_20251124(size)
  if (/^claude-(sonnet-4|opus-4|3-7-sonnet|haiku-4-5)/.test(id))
    return anthropicTools.computer_20250124(size)
  return null
}

/** Normalised streaming events, independent of the underlying protocol. */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'finish'; usage: Usage; finishReason: string }
  /** The assistant message(s) exactly as the SDK would replay them, incl. signed thinking blocks. */
  | { type: 'response'; messages: ModelMessage[] }
  | { type: 'error'; message: string }

export interface StreamChatOptions {
  model: ModelRef
  messages: ModelMessage[]
  system?: string
  temperature?: number
  maxOutputTokens?: number
  thinking?: ThinkingLevel
  tools?: ToolSet
  signal?: AbortSignal
}

/**
 * Stream one model turn. Tool calls are surfaced but not executed: the agent
 * loop (M2) owns execution so it can ask for approval first.
 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatEvent> {
  let protocol: Protocol
  let model: LanguageModel
  try {
    ;({ model, protocol } = createLanguageModel(opts.model))
  } catch (err) {
    yield { type: 'error', message: errorMessage(err) }
    return
  }

  // Anthropic only caches up to explicit breakpoints; OpenAI caches prefixes automatically.
  const prompt =
    protocol === 'anthropic'
      ? withCacheBreakpoints(opts.messages, opts.system || undefined)
      : { messages: opts.messages, system: opts.system || undefined }
  const result = streamText({
    model,
    messages: prompt.messages,
    system: prompt.system,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    tools: opts.tools,
    providerOptions: requestOptions(protocol, opts.thinking ?? 'off') as never,
    abortSignal: opts.signal,
    maxRetries: 1,
  })

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          if (part.text) yield { type: 'text', text: part.text }
          break
        case 'reasoning-delta':
          if (part.text) yield { type: 'reasoning', text: part.text }
          break
        case 'tool-call':
          yield { type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input }
          break
        case 'error':
          yield { type: 'error', message: errorMessage(part.error) }
          return
        case 'finish':
          yield {
            type: 'finish',
            finishReason: part.finishReason,
            usage: {
              inputTokens: part.totalUsage.inputTokens,
              outputTokens: part.totalUsage.outputTokens,
              reasoningTokens: part.totalUsage.outputTokenDetails?.reasoningTokens,
              cacheReadTokens: part.totalUsage.inputTokenDetails?.cacheReadTokens,
              cacheWriteTokens: part.totalUsage.inputTokenDetails?.cacheWriteTokens,
            },
          }
          break
      }
    }
    const response = await result.response
    yield { type: 'response', messages: response.messages as ModelMessage[] }
  } catch (err) {
    if (opts.signal?.aborted) return
    yield { type: 'error', message: errorMessage(err) }
  }
}

const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const

/**
 * Mark Anthropic prompt-cache breakpoints, so each agent step re-reads the
 * shared prefix at a fraction of the price instead of paying for it again:
 *
 * - the system prompt (cached together with the tool definitions before it);
 * - the end of the previous request (the input before the newest assistant
 *   turn), which is what the previous step wrote to the cache;
 * - the end of this request, written for the next step.
 *
 * Uses block-level `cache_control`, which gateways forward more reliably than
 * the newer request-level automatic caching. Never mutates `messages`; the
 * system prompt comes back as a message so it can carry its breakpoint.
 */
export function withCacheBreakpoints(
  messages: ModelMessage[],
  system?: string,
): { messages: ModelMessage[]; system?: SystemModelMessage } {
  const out: ModelMessage[] = messages.map((m) => ({ ...m }) as ModelMessage)
  const mark = (i: number) => {
    const m = out[i]
    if (!m || (Array.isArray(m.content) && !m.content.length) || m.content === '') return
    out[i] = { ...m, providerOptions: { ...m.providerOptions, ...CACHE } } as ModelMessage
  }
  const last = out.length - 1
  const lastAssistant = out.findLastIndex((m) => m.role === 'assistant')
  mark(last)
  if (lastAssistant > 0 && lastAssistant - 1 !== last) mark(lastAssistant - 1)
  return {
    messages: out,
    system: system ? { role: 'system', content: system, providerOptions: CACHE } : undefined,
  }
}

/** Turn SDK / HTTP errors into something a user can act on. */
export function errorMessage(err: unknown): string {
  if (APICallError.isInstance(err)) {
    const detail = extractErrorDetail(err.responseBody)
    const status = err.statusCode ? `HTTP ${err.statusCode}` : '请求失败'
    if (err.statusCode === 401 || err.statusCode === 403)
      return `${status}：Key 无效或无权限${detail ? `（${detail}）` : ''}`
    if (err.statusCode === 404) return `${status}：接口或模型不存在${detail ? `（${detail}）` : ''}`
    if (err.statusCode === 429)
      return `${status}：请求过于频繁或额度不足${detail ? `（${detail}）` : ''}`
    return `${status}${detail ? `：${detail}` : `：${err.message}`}`
  }
  if (err instanceof Error) return err.message
  return String(err)
}

function extractErrorDetail(body: string | undefined): string {
  if (!body) return ''
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    const msg = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.message)
    if (msg) return msg.slice(0, 300)
  } catch {
    // not JSON
  }
  return body.slice(0, 300)
}
