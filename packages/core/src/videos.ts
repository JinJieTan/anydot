import { authHeaders } from './models'
import { normalizeBaseUrl } from './provider'

/**
 * OpenAI Videos API (as served for Sora-style models by OpenAI-compatible
 * gateways): create → poll → download content. Generation takes minutes, so
 * callers persist the remote id and can resume polling after a restart.
 */
export interface VideoRequest {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  /** e.g. "4", "8", "12" */
  seconds?: string
  /** e.g. "1280x720", "720x1280" */
  size?: string
  /** Optional first-frame / reference image. */
  image?: { data: Uint8Array; mime: string; name: string }
  signal?: AbortSignal
  fetch?: typeof fetch
}

export interface VideoJob {
  id: string
  status: 'queued' | 'in_progress' | 'completed' | 'failed'
  progress?: number
  error?: string
}

interface VideoApiObject {
  id?: string
  status?: string
  progress?: number
  error?: { message?: string; code?: string } | null
}

async function parse(res: Response, what: string): Promise<VideoApiObject> {
  const text = await res.text()
  let json: VideoApiObject & { error?: { message?: string } }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${what}失败：HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  if (!res.ok)
    throw new Error(`${what}失败：HTTP ${res.status} ${json.error?.message ?? text.slice(0, 200)}`)
  return json
}

function toJob(o: VideoApiObject): VideoJob {
  if (!o.id) throw new Error('接口没有返回视频任务 ID')
  const status =
    (['queued', 'in_progress', 'completed', 'failed'] as const).find((s) => s === o.status) ??
    'in_progress'
  return { id: o.id, status, progress: o.progress, error: o.error?.message ?? undefined }
}

export async function createVideo(req: VideoRequest): Promise<VideoJob> {
  const doFetch = req.fetch ?? fetch
  const form = new FormData()
  form.set('model', req.model)
  form.set('prompt', req.prompt)
  if (req.seconds) form.set('seconds', req.seconds)
  if (req.size) form.set('size', req.size)
  if (req.image) {
    form.set(
      'input_reference',
      new Blob([new Uint8Array(req.image.data)], { type: req.image.mime }),
      req.image.name,
    )
  }
  const res = await doFetch(`${normalizeBaseUrl(req.baseUrl)}/videos`, {
    method: 'POST',
    headers: authHeaders(req.apiKey),
    body: form,
    signal: req.signal,
  })
  return toJob(await parse(res, '创建视频任务'))
}

export async function getVideo(opts: {
  baseUrl: string
  apiKey: string
  id: string
  signal?: AbortSignal
  fetch?: typeof fetch
}): Promise<VideoJob> {
  const res = await (opts.fetch ?? fetch)(
    `${normalizeBaseUrl(opts.baseUrl)}/videos/${encodeURIComponent(opts.id)}`,
    {
      headers: authHeaders(opts.apiKey),
      signal: opts.signal,
    },
  )
  return toJob(await parse(res, '查询视频任务'))
}

export async function downloadVideo(opts: {
  baseUrl: string
  apiKey: string
  id: string
  signal?: AbortSignal
  fetch?: typeof fetch
}): Promise<{ data: Uint8Array; mime: string }> {
  const res = await (opts.fetch ?? fetch)(
    `${normalizeBaseUrl(opts.baseUrl)}/videos/${encodeURIComponent(opts.id)}/content`,
    { headers: authHeaders(opts.apiKey), signal: opts.signal },
  )
  if (!res.ok) throw new Error(`下载视频失败：HTTP ${res.status}`)
  return {
    data: new Uint8Array(await res.arrayBuffer()),
    mime: res.headers.get('content-type')?.split(';')[0] || 'video/mp4',
  }
}

/** Poll until the job finishes. `onProgress` is called on every poll. */
export async function waitForVideo(
  opts: {
    baseUrl: string
    apiKey: string
    id: string
    signal?: AbortSignal
    fetch?: typeof fetch
    intervalMs?: number
  },
  onProgress?: (job: VideoJob) => void,
): Promise<VideoJob> {
  const interval = opts.intervalMs ?? 5000
  for (;;) {
    const job = await getVideo(opts)
    onProgress?.(job)
    if (job.status === 'completed' || job.status === 'failed') return job
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, interval)
      opts.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new Error('已取消'))
        },
        { once: true },
      )
    })
  }
}
