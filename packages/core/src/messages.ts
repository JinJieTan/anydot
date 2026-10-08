/**
 * Persisted message format (messages.parts_json). Provider-neutral so a
 * conversation can switch between Claude and GPT mid-thread.
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; blob: string; mime: string; name?: string }
  | { type: 'file'; blob: string; mime: string; name: string }
  /** `server`: run by the provider (e.g. native web search); shown, never replayed. */
  | { type: 'tool_call'; id: string; name: string; input: unknown; server?: boolean }
  | {
      type: 'tool_result'
      id: string
      name: string
      output: unknown
      isError?: boolean
      /** Screenshots the tool returned, stored as blobs. */
      images?: { blob: string; mime: string }[]
      /** Files before this call changed them (blob null: it didn't exist), for undo. */
      backups?: { path: string; blob: string | null }[]
    }
  /** Compacted history: everything before this message is replaced by `text`. */
  | { type: 'summary'; text: string }

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface StoredMessage {
  id: string
  conversationId: string
  parentId: string | null
  role: Role
  parts: MessagePart[]
  modelId?: string | null
  usage?: Usage | null
  status: MessageStatus
  createdAt: number
}

export type MessageStatus = 'complete' | 'streaming' | 'error' | 'aborted'

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  /** Tokens written to the prompt cache (Anthropic). */
  cacheWriteTokens?: number
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

/** Text files we inline into the prompt instead of sending as binary. */
export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    /^application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|x-sh|sql)/.test(mime)
  )
}

export function textOf(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}
