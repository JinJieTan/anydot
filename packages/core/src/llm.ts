import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import {
  APICallError,
  streamText,
  type LanguageModel,
  type ModelMessage,
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
      return { protocol, model: createAnthropic({ baseURL, apiKey })(ref.modelId) }
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

export type BlobLoader = (sha256: string) => Promise<Uint8Array>

/** Convert a stored conversation path (root → leaf) into AI SDK model messages. */
export async function toModelMessages(
  path: StoredMessage[],
  loadBlob: BlobLoader,
): Promise<ModelMessage[]> {
  const out: ModelMessage[] = []
  for (const msg of path) {
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
        else if (part.type === 'tool_call')
          content.push({
            type: 'tool-call',
            toolCallId: part.id,
            toolName: part.name,
            input: part.input,
          })
      }
      if (content.length) out.push({ role: 'assistant', content })
    } else if (msg.role === 'tool') {
      const content = msg.parts
        .filter((p): p is Extract<MessagePart, { type: 'tool_result' }> => p.type === 'tool_result')
        .map((p) => ({
          type: 'tool-result' as const,
          toolCallId: p.id,
          toolName: p.name,
          output: p.isError
            ? { type: 'error-text' as const, value: String(p.output) }
            : typeof p.output === 'string'
              ? { type: 'text' as const, value: p.output }
              : { type: 'json' as const, value: p.output as never },
        }))
      if (content.length) out.push({ role: 'tool', content })
    }
  }
  return out
}

/** Normalised streaming events, independent of the underlying protocol. */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'finish'; usage: Usage; finishReason: string }
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

  const result = streamText({
    model,
    messages: opts.messages,
    system: opts.system || undefined,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    tools: opts.tools,
    providerOptions: thinkingOptions(protocol, opts.thinking ?? 'off') as never,
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
            },
          }
          break
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) return
    yield { type: 'error', message: errorMessage(err) }
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
