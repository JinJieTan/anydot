import { normalizeBaseUrl, resolveProtocol, type ProviderType } from './provider'

export type Capability = 'chat' | 'vision' | 'reasoning' | 'image' | 'video'

export interface RemoteModel {
  id: string
  capabilities: Capability[]
}

/** Headers accepted by OpenAI-compatible and Anthropic-compatible gateways alike. */
export function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
}

/** GET {base}/v1/models. Works for OpenAI, Anthropic and new-api style gateways. */
export async function listModels(
  baseUrl: string,
  apiKey: string,
  opts: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<RemoteModel[]> {
  const doFetch = opts.fetch ?? fetch
  const res = await doFetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: authHeaders(apiKey),
    signal: opts.signal ?? AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`获取模型列表失败：HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`)
  }
  const json = (await res.json()) as { data?: { id?: string }[] }
  const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id)
  return [...new Set(ids)].sort().map((id) => ({ id, capabilities: inferCapabilities(id) }))
}

/** Best-effort guess from the model id; users can correct it in settings. */
export function inferCapabilities(modelId: string, type: ProviderType = 'auto'): Capability[] {
  const id = modelId.toLowerCase()
  if (resolveProtocol(modelId, type) === 'openai-images') return ['image']
  if (/^(sora|veo|kling|seedance|runway|hailuo|video)/.test(id) || id.includes('video'))
    return ['video']

  const caps: Capability[] = ['chat']
  if (/claude|gpt-4o|gpt-4\.1|gpt-5|gpt-6|o\d|gemini|vision|vl|qwen.*vl|glm-4v/.test(id))
    caps.push('vision')
  if (
    /claude-(opus|sonnet|haiku)-[4-9]|claude-3-7|o\d|gpt-5|gpt-6|reason|think|r1|deepseek-reasoner/.test(
      id,
    )
  )
    caps.push('reasoning')
  return caps
}
