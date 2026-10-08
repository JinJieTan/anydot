import {
  createVideo,
  downloadVideo,
  generateImages,
  waitForVideo,
  type ImageInput,
  type ProviderCredentials,
} from '@aitech/core'
import type { ImageJobRow, Store } from '@aitech/db'
import type { ImageGenerateInput } from '../shared/ipc'
import type { BlobStore } from './blobs'
import { decryptKey } from './secrets'

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Image and video generation jobs. Video jobs survive restarts by remote id. */
export class ImageService {
  private controllers = new Map<string, AbortController>()
  private quitting = false

  constructor(
    private readonly store: Store,
    private readonly blobs: BlobStore,
    private readonly emit: (job: ImageJobRow) => void,
  ) {}

  private credentials(modelRowId: string) {
    const model = this.store.getModel(modelRowId)
    if (!model) throw new Error('模型不存在')
    const provider = this.store.getProvider(model.providerId)
    const apiKey = provider && decryptKey(provider.keyRef)
    if (!provider || !apiKey) throw new Error('服务商未配置 Key')
    return {
      model,
      creds: { baseUrl: provider.baseUrl, apiKey, type: provider.type } as ProviderCredentials,
    }
  }

  /** Create a job and run it in the background. Returns immediately. */
  generate(input: ImageGenerateInput): ImageJobRow {
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('请输入提示词')
    const { model, creds } = this.credentials(input.modelId)
    const isVideo = model.capabilities.includes('video')

    const job = this.store.createImageJob({
      prompt,
      params: { ...input.params, kind: isVideo ? 'video' : 'image' },
      modelId: model.modelId,
      sourceBlobIds: input.sourceBlobIds,
    })
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    const run = isVideo
      ? this.runVideo(job, creds, controller)
      : this.runImage(job, creds, controller)
    void run.finally(() => this.controllers.delete(job.id))
    return job
  }

  /** Resume polling video jobs left running when the app last quit. */
  resume(): void {
    for (const job of this.store.resumableVideoJobs()) {
      const row = this.store
        .listModels()
        .find((m) => m.modelId === job.modelId && m.capabilities.includes('video'))
      let creds: ProviderCredentials
      try {
        creds = this.credentials(row?.id ?? '').creds
      } catch (err) {
        this.emit(
          this.store.finishImageJob(job.id, { status: 'error', error: (err as Error).message }),
        )
        continue
      }
      const controller = new AbortController()
      this.controllers.set(job.id, controller)
      void this.runVideo(job, creds, controller).finally(() => this.controllers.delete(job.id))
    }
  }

  private async sources(job: ImageJobRow): Promise<ImageInput[]> {
    return Promise.all(
      job.sourceBlobIds.map(async (sha, i) => {
        const mime = this.blobs.mime(sha)
        return {
          data: await this.blobs.read(sha),
          mime,
          name: `image-${i + 1}.${EXT[mime] ?? 'png'}`,
        }
      }),
    )
  }

  private async runImage(
    job: ImageJobRow,
    creds: ProviderCredentials,
    controller: AbortController,
  ) {
    try {
      const res = await generateImages({
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
        model: job.modelId!,
        prompt: job.prompt,
        size: job.params.size,
        quality: job.params.quality,
        n: job.params.n,
        background: job.params.background,
        images: await this.sources(job),
        signal: controller.signal,
      })
      const ids: string[] = []
      for (const img of res.images) ids.push(await this.blobs.put(img.data, img.mime))
      this.emit(
        this.store.finishImageJob(job.id, { status: 'done', resultBlobIds: ids, usage: res.usage }),
      )
    } catch (err) {
      this.fail(job, controller, err)
    }
  }

  private async runVideo(
    job: ImageJobRow,
    creds: ProviderCredentials,
    controller: AbortController,
  ) {
    const opts = { baseUrl: creds.baseUrl, apiKey: creds.apiKey, signal: controller.signal }
    try {
      let remoteId = job.params.remoteId
      if (!remoteId) {
        const [image] = await this.sources(job)
        const created = await createVideo({
          ...opts,
          model: job.modelId!,
          prompt: job.prompt,
          seconds: job.params.seconds,
          size: job.params.size,
          image,
        })
        remoteId = created.id
        this.emit(
          this.store.updateImageJobParams(job.id, { remoteId, progress: created.progress ?? 0 }),
        )
      }
      let last = -1
      const done = await waitForVideo({ ...opts, id: remoteId }, (j) => {
        if (j.progress !== undefined && j.progress !== last) {
          last = j.progress
          this.emit(this.store.updateImageJobParams(job.id, { progress: j.progress }))
        }
      })
      if (done.status === 'failed') throw new Error(done.error ?? '视频生成失败')
      const file = await downloadVideo({ ...opts, id: remoteId })
      const sha = await this.blobs.put(file.data, file.mime)
      this.store.updateImageJobParams(job.id, { progress: 100 })
      this.emit(this.store.finishImageJob(job.id, { status: 'done', resultBlobIds: [sha] }))
    } catch (err) {
      this.fail(job, controller, err)
    }
  }

  private fail(job: ImageJobRow, controller: AbortController, err: unknown) {
    // Shutting down: leave running jobs as they are so video jobs resume next launch.
    if (this.quitting) return
    const message = controller.signal.aborted ? '已取消' : (err as Error).message
    this.emit(this.store.finishImageJob(job.id, { status: 'error', error: message }))
  }

  delete(id: string): void {
    this.controllers.get(id)?.abort()
    this.store.deleteImageJob(id)
  }

  stopAll(): void {
    // Video jobs keep their remote id and resume next launch.
    this.quitting = true
    for (const c of this.controllers.values()) c.abort()
  }
}
