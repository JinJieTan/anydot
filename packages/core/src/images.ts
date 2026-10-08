import { base64ToBytes } from './bytes'
import { authHeaders } from './models'
import { normalizeBaseUrl } from './provider'

export interface ImageInput {
  data: Uint8Array
  mime: string
  name: string
}

export interface ImageRequest {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  size?: string
  quality?: string
  n?: number
  background?: 'auto' | 'transparent' | 'opaque'
  /** Reference images. When present the request goes to /images/edits. */
  images?: ImageInput[]
  mask?: ImageInput
  signal?: AbortSignal
  fetch?: typeof fetch
}

export interface GeneratedImage {
  data: Uint8Array
  mime: string
  revisedPrompt?: string
}

export interface ImageResult {
  images: GeneratedImage[]
  usage?: { inputTokens?: number; outputTokens?: number }
}

interface ImagesApiResponse {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

/** OpenAI Images API (generations + edits), as served by gpt-image-* models. */
export async function generateImages(req: ImageRequest): Promise<ImageResult> {
  const doFetch = req.fetch ?? fetch
  const base = normalizeBaseUrl(req.baseUrl)
  const headers = authHeaders(req.apiKey)
  const isEdit = !!req.images?.length

  let res: Response
  if (isEdit) {
    const form = new FormData()
    form.set('model', req.model)
    form.set('prompt', req.prompt)
    if (req.size) form.set('size', req.size)
    if (req.quality) form.set('quality', req.quality)
    if (req.n) form.set('n', String(req.n))
    if (req.background) form.set('background', req.background)
    for (const img of req.images!) {
      form.append('image[]', new Blob([new Uint8Array(img.data)], { type: img.mime }), img.name)
    }
    if (req.mask)
      form.set(
        'mask',
        new Blob([new Uint8Array(req.mask.data)], { type: req.mask.mime }),
        req.mask.name,
      )
    res = await doFetch(`${base}/images/edits`, {
      method: 'POST',
      headers,
      body: form,
      signal: req.signal,
    })
  } else {
    res = await doFetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        size: req.size,
        quality: req.quality,
        n: req.n,
        background: req.background,
      }),
      signal: req.signal,
    })
  }

  const text = await res.text()
  let json: ImagesApiResponse
  try {
    json = JSON.parse(text) as ImagesApiResponse
  } catch {
    throw new Error(`生图失败：HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  if (!res.ok || json.error) {
    throw new Error(`生图失败：HTTP ${res.status} ${json.error?.message ?? text.slice(0, 200)}`)
  }

  const images: GeneratedImage[] = []
  for (const item of json.data ?? []) {
    if (item.b64_json) {
      images.push({
        data: base64ToBytes(item.b64_json),
        mime: sniffImageMime(item.b64_json),
        revisedPrompt: item.revised_prompt,
      })
    } else if (item.url) {
      const img = await doFetch(item.url, { signal: req.signal })
      if (!img.ok) throw new Error(`下载生成的图片失败：HTTP ${img.status}`)
      images.push({
        data: new Uint8Array(await img.arrayBuffer()),
        mime: img.headers.get('content-type') ?? 'image/png',
        revisedPrompt: item.revised_prompt,
      })
    }
  }
  if (!images.length) throw new Error('生图失败：接口没有返回图片')

  return {
    images,
    usage: json.usage && {
      inputTokens: json.usage.input_tokens,
      outputTokens: json.usage.output_tokens,
    },
  }
}

function sniffImageMime(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}
