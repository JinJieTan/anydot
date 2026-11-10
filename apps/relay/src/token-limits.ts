/**
 * Input/output token limits for the default provider. Input is estimated from
 * the request body (no tokenizer); output is capped by rewriting the request,
 * so the model stops there and nothing past it is generated or billed.
 */

/** Keys whose string values are labels, not text the model reads. */
const LABELS = new Set(['model', 'type', 'role', 'media_type', 'detail'])

/** Rough cost of one image in input tokens. */
const IMAGE_TOKENS = 1000
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

function textTokens(s: string): number {
  const cjk = s.match(CJK)?.length ?? 0
  return cjk + Math.ceil((s.length - cjk) / 4)
}

/** Tokens for a base64 payload: images cost a flat amount, other files by size. */
function base64Tokens(data: string, mime: string): number {
  if (mime.startsWith('image/')) return IMAGE_TOKENS
  return Math.ceil((data.length * 3) / 4 / 4)
}

/**
 * Estimated input tokens of a chat request (Chat Completions, Responses or
 * Anthropic Messages). Errs high for CJK, which is what users here write.
 */
export function estimateInputTokens(body: unknown): number {
  let total = 0
  const walk = (v: unknown, key: string, parent: Record<string, unknown> | null) => {
    if (typeof v === 'string') {
      const dataUrl = /^data:([\w.+-]+\/[\w.+-]+)?(;[^,]*)?,/.exec(v)
      if (dataUrl) total += base64Tokens(v.slice(dataUrl[0].length), dataUrl[1] ?? '')
      else if (key === 'data' && parent?.type === 'base64')
        // Anthropic: { type: 'base64', media_type, data }
        total += base64Tokens(v, String(parent.media_type ?? ''))
      else if (!LABELS.has(key)) total += textTokens(v)
      return
    }
    if (Array.isArray(v)) for (const x of v) walk(x, key, parent)
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        walk(x, k, v as Record<string, unknown>)
  }
  walk(body, '', null)
  return total
}

const min = (a: unknown, cap: number) =>
  typeof a === 'number' && Number.isFinite(a) && a > 0 ? Math.min(a, cap) : cap

/**
 * Caps the output tokens a request may produce, in place. `path` is the part
 * after /v1. Returns whether the body changed.
 */
export function capOutputTokens(path: string, body: Record<string, unknown>, cap: number): boolean {
  const before = JSON.stringify(body)
  if (path === '/responses') {
    body.max_output_tokens = min(body.max_output_tokens, cap)
  } else if (path === '/chat/completions') {
    const has = (k: string) => body[k] !== undefined && body[k] !== null
    if (has('max_completion_tokens') || has('max_tokens')) {
      if (has('max_completion_tokens'))
        body.max_completion_tokens = min(body.max_completion_tokens, cap)
      if (has('max_tokens')) body.max_tokens = min(body.max_tokens, cap)
    } else {
      // Reasoning models reject max_tokens on the OpenAI API.
      const reasoning = /^(o\d|gpt-5|gpt-6)/i.test(String(body.model ?? ''))
      body[reasoning ? 'max_completion_tokens' : 'max_tokens'] = cap
    }
  } else if (path === '/messages') {
    body.max_tokens = min(body.max_tokens, cap)
    // Extended thinking needs budget_tokens < max_tokens (and at least 1024).
    const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined
    if (thinking?.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
      const max = body.max_tokens as number
      if (thinking.budget_tokens >= max) {
        if (max - 1 >= 1024) thinking.budget_tokens = max - 1
        else delete body.thinking
      }
    }
  } else {
    return false
  }
  return JSON.stringify(body) !== before
}
