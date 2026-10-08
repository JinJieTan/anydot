import { generateImages, type ImageInput } from '@aitech/core'
import type { ImageJobRow, Store } from '@aitech/db'
import type { ImageGenerateInput } from '../shared/ipc'
import type { BlobStore } from './blobs'
import { decryptKey } from './secrets'

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export class ImageService {
  private controllers = new Map<string, AbortController>()

  constructor(
    private readonly store: Store,
    private readonly blobs: BlobStore,
    private readonly emit: (job: ImageJobRow) => void,
  ) {}

  /** Create a job and run it in the background. Returns immediately. */
  generate(input: ImageGenerateInput): ImageJobRow {
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('请输入提示词')
    const model = this.store.getModel(input.modelId)
    if (!model) throw new Error('生图模型不存在')
    const provider = this.store.getProvider(model.providerId)
    const apiKey = provider && decryptKey(provider.keyRef)
    if (!provider || !apiKey) throw new Error('服务商未配置 Key')

    const job = this.store.createImageJob({
      prompt,
      params: input.params,
      modelId: model.modelId,
      sourceBlobIds: input.sourceBlobIds,
    })
    const controller = new AbortController()
    this.controllers.set(job.id, controller)

    void (async () => {
      try {
        const images: ImageInput[] = await Promise.all(
          input.sourceBlobIds.map(async (sha, i) => {
            const mime = this.blobs.mime(sha)
            return {
              data: await this.blobs.read(sha),
              mime,
              name: `image-${i + 1}.${EXT[mime] ?? 'png'}`,
            }
          }),
        )
        const res = await generateImages({
          baseUrl: provider.baseUrl,
          apiKey,
          model: model.modelId,
          prompt,
          size: input.params.size,
          quality: input.params.quality,
          n: input.params.n,
          background: input.params.background,
          images,
          signal: controller.signal,
        })
        const ids: string[] = []
        for (const img of res.images) ids.push(await this.blobs.put(img.data, img.mime))
        this.emit(
          this.store.finishImageJob(job.id, {
            status: 'done',
            resultBlobIds: ids,
            usage: res.usage,
          }),
        )
      } catch (err) {
        const message = controller.signal.aborted ? '已取消' : (err as Error).message
        this.emit(this.store.finishImageJob(job.id, { status: 'error', error: message }))
      } finally {
        this.controllers.delete(job.id)
      }
    })()

    return job
  }

  delete(id: string): void {
    this.controllers.get(id)?.abort()
    this.store.deleteImageJob(id)
  }

  stopAll(): void {
    for (const c of this.controllers.values()) c.abort()
  }
}
