/** How the user declared a provider. `auto` lets us route per model id. */
export type ProviderType = 'auto' | 'openai' | 'anthropic'

/** Wire protocol used for a single request. */
export type Protocol = 'anthropic' | 'openai-responses' | 'openai-chat' | 'openai-images'

export interface Provider {
  id: string
  name: string
  baseUrl: string
  type: ProviderType
}

const IMAGE_MODEL = /^(gpt-image|dall-e)/i
const CLAUDE_MODEL = /^claude/i

/**
 * Pick the wire protocol for a model.
 * An explicit per-model override always wins; otherwise image models go to the
 * images API, `anthropic` providers (or claude-* under `auto`) use Messages,
 * and everything else uses the OpenAI Responses API.
 */
export function resolveProtocol(
  modelId: string,
  providerType: ProviderType,
  override?: Protocol,
): Protocol {
  if (override) return override
  if (IMAGE_MODEL.test(modelId)) return 'openai-images'
  if (providerType === 'anthropic') return 'anthropic'
  if (providerType === 'auto' && CLAUDE_MODEL.test(modelId)) return 'anthropic'
  return 'openai-responses'
}

/**
 * Normalise a user-entered base URL to the API root ending in `/v1`.
 * Accepts `https://host`, `https://host/`, `https://host/v1`, `https://host/v1/`.
 */
export function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim())
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}
