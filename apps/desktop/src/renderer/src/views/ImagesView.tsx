import clsx from 'clsx'
import { AlertCircle, Copy, Download, ImagePlus, Trash2, Wand2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImageJobParams } from '@aitech/db'
import type { Attachment, ImageJobDTO } from '../../../shared/ipc'
import { ModelPicker } from '../components/ModelPicker'
import { Button, Field, IconButton, Modal, Select, Spinner, Textarea } from '../components/ui'
import { api, blobUrl, invoke } from '../lib/api'
import { formatTime, readFileAsBytes } from '../lib/format'
import { attempt, succeeded, useApp } from '../store/app'

const SIZES = [
  { value: 'auto', label: '自动' },
  { value: '1024x1024', label: '1:1 方形' },
  { value: '1536x1024', label: '3:2 横向' },
  { value: '1024x1536', label: '2:3 纵向' },
]
const QUALITIES = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低（快）' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高（慢）' },
]

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function ImagesView() {
  const { models, settings, updateSettings, setView } = useApp()
  const imageModels = useMemo(
    () => models.filter((m) => m.capabilities.includes('image')),
    [models],
  )
  const [jobs, setJobs] = useState<ImageJobDTO[]>([])
  const [prompt, setPrompt] = useState('')
  const [params, setParams] = useState<ImageJobParams>({
    size: 'auto',
    quality: 'auto',
    n: 1,
    background: 'auto',
  })
  const [refs, setRefs] = useState<Attachment[]>([])
  const [viewing, setViewing] = useState<{ sha: string; job: ImageJobDTO } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const modelId =
    imageModels.find((m) => m.id === settings.defaultImageModelId)?.id ?? imageModels[0]?.id ?? null

  useEffect(() => {
    void invoke('images.list').then(setJobs)
    return api.on('image', (job) =>
      setJobs((list) => {
        const i = list.findIndex((j) => j.id === job.id)
        if (i === -1) return [job, ...list]
        const next = list.slice()
        next[i] = job
        return next
      }),
    )
  }, [])

  const addRefs = async (files: File[]) => {
    for (const f of files.filter((f) => f.type.startsWith('image/'))) {
      const att = await attempt(async () =>
        invoke('blobs.put', { data: await readFileAsBytes(f), mime: f.type, name: f.name }),
      )
      if (att) setRefs((r) => (r.some((x) => x.blob === att.blob) ? r : [...r, att]))
    }
  }

  const generate = async () => {
    if (!modelId || !prompt.trim()) return
    const job = await attempt(() =>
      invoke('images.generate', {
        modelId,
        prompt,
        params: {
          ...params,
          size: params.size === 'auto' ? undefined : params.size,
          quality: params.quality === 'auto' ? undefined : params.quality,
          background: params.background === 'auto' ? undefined : params.background,
        },
        sourceBlobIds: refs.map((r) => r.blob),
      }),
    )
    if (job) setJobs((list) => [job, ...list.filter((j) => j.id !== job.id)])
  }

  const addAsReference = (sha: string) => {
    setRefs((r) =>
      r.some((x) => x.blob === sha)
        ? r
        : [...r, { blob: sha, mime: 'image/png', name: 'image.png' }],
    )
    setViewing(null)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-12 shrink-0 items-center border-b border-line px-4">
        <h1 className="text-sm font-medium">生图</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        {/* ── form ── */}
        <div className="w-80 shrink-0 space-y-4 overflow-y-auto border-r border-line p-4">
          {imageModels.length === 0 ? (
            <div className="rounded-xl border border-line p-4 text-sm text-fg-soft">
              还没有可用的生图模型（如 gpt-image-2）。
              <Button className="mt-3 w-full" onClick={() => setView('settings')}>
                去设置添加
              </Button>
            </div>
          ) : (
            <Field label="模型">
              <div className="rounded-lg border border-line">
                <ModelPicker
                  capability="image"
                  direction="down"
                  value={modelId}
                  onChange={(id) => void updateSettings({ defaultImageModelId: id })}
                />
              </div>
            </Field>
          )}

          <Field label="提示词">
            <Textarea
              rows={6}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate()
              }}
              placeholder="描述你想要的画面，例如：清晨薄雾中的江南水乡，水彩风格"
            />
          </Field>

          <Field label="参考图（可选，用于编辑或风格参考）">
            <div
              className="flex flex-wrap gap-2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                void addRefs([...e.dataTransfer.files])
              }}
            >
              {refs.map((r) => (
                <div key={r.blob} className="group relative">
                  <img
                    src={blobUrl(r.blob)}
                    alt=""
                    className="size-16 rounded-lg border border-line object-cover"
                  />
                  <button
                    type="button"
                    aria-label="移除参考图"
                    onClick={() => setRefs((list) => list.filter((x) => x.blob !== r.blob))}
                    className="absolute -top-1.5 -right-1.5 hidden size-5 items-center justify-center rounded-full bg-fg text-surface group-hover:flex"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex size-16 items-center justify-center rounded-lg border border-dashed border-line-strong text-fg-faint hover:border-accent hover:text-accent"
                title="添加参考图"
              >
                <ImagePlus className="size-5" />
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  void addRefs([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="尺寸">
              <Select
                value={params.size}
                onChange={(e) => setParams({ ...params, size: e.target.value })}
              >
                {SIZES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="质量">
              <Select
                value={params.quality}
                onChange={(e) => setParams({ ...params, quality: e.target.value })}
              >
                {QUALITIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="数量">
              <Select
                value={params.n}
                onChange={(e) => setParams({ ...params, n: Number(e.target.value) })}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n} 张
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="背景">
              <Select
                value={params.background}
                onChange={(e) =>
                  setParams({
                    ...params,
                    background: e.target.value as ImageJobParams['background'],
                  })
                }
              >
                <option value="auto">自动</option>
                <option value="opaque">不透明</option>
                <option value="transparent">透明</option>
              </Select>
            </Field>
          </div>

          <Button
            variant="primary"
            className="w-full"
            disabled={!modelId || !prompt.trim()}
            onClick={() => void generate()}
          >
            <Wand2 className="size-4" />
            {refs.length ? '编辑生成' : '生成'}
          </Button>
          <p className="text-center text-xs text-fg-faint">⌘/Ctrl + Enter 快速生成</p>
        </div>

        {/* ── gallery ── */}
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {jobs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-sm text-fg-faint">
              <Wand2 className="mb-3 size-8" />
              生成的图片会出现在这里
            </div>
          ) : (
            <div className="space-y-8">
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onView={(sha) => setViewing({ sha, job })}
                  onReuse={() => {
                    setPrompt(job.prompt)
                    setRefs(
                      job.sourceBlobIds.map((b) => ({
                        blob: b,
                        mime: 'image/png',
                        name: 'image.png',
                      })),
                    )
                  }}
                  onDelete={async () => {
                    if (!window.confirm('删除这条生成记录？')) return
                    const ok = await succeeded(() => invoke('images.delete', job.id))
                    if (ok) setJobs((list) => list.filter((j) => j.id !== job.id))
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal open={!!viewing} onClose={() => setViewing(null)} wide>
        {viewing && (
          <div>
            <div className="flex items-center justify-center bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:20px_20px] p-4">
              <img
                src={blobUrl(viewing.sha)}
                alt=""
                className="max-h-[70vh] max-w-full rounded-lg"
              />
            </div>
            <div className="flex items-center gap-2 border-t border-line px-4 py-3">
              <p className="line-clamp-2 min-w-0 flex-1 text-sm text-fg-soft">
                {viewing.job.prompt}
              </p>
              <ImageActions sha={viewing.sha} onUseAsRef={() => addAsReference(viewing.sha)} />
              <IconButton label="关闭" onClick={() => setViewing(null)}>
                <X className="size-4" />
              </IconButton>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function ImageActions({ sha, onUseAsRef }: { sha: string; onUseAsRef?: () => void }) {
  const { notify } = useApp()
  return (
    <>
      {onUseAsRef && (
        <Button size="sm" onClick={onUseAsRef}>
          <ImagePlus className="size-3.5" />
          作为参考图
        </Button>
      )}
      <Button
        size="sm"
        onClick={async () => {
          const ok = await succeeded(() => invoke('blobs.copyImage', sha))
          if (ok) notify('已复制到剪贴板')
        }}
      >
        <Copy className="size-3.5" />
        复制
      </Button>
      <Button
        size="sm"
        onClick={() =>
          void attempt(() =>
            invoke('blobs.saveAs', {
              sha256: sha,
              suggestedName: `aitech-${sha.slice(0, 8)}.${EXT['image/png']}`,
            }),
          )
        }
      >
        <Download className="size-3.5" />
        保存
      </Button>
    </>
  )
}

function JobCard({
  job,
  onView,
  onReuse,
  onDelete,
}: {
  job: ImageJobDTO
  onView: (sha: string) => void
  onReuse: () => void
  onDelete: () => void
}) {
  const count = job.params.n ?? 1
  return (
    <div className="group">
      <div className="mb-2 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed">{job.prompt}</p>
          <p className="mt-0.5 text-xs text-fg-faint">
            {job.modelId} · {job.params.size ?? '自动尺寸'} · {formatTime(job.createdAt)}
            {job.sourceBlobIds.length > 0 && ` · ${job.sourceBlobIds.length} 张参考图`}
          </p>
        </div>
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button size="sm" variant="ghost" onClick={onReuse}>
            复用
          </Button>
          <IconButton label="删除" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </div>
      {job.status === 'error' ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-all">{job.error}</span>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {job.status === 'done'
            ? job.resultBlobIds.map((sha, i) => (
                <button
                  key={`${sha}-${i}`}
                  type="button"
                  onClick={() => onView(sha)}
                  className="overflow-hidden rounded-xl border border-line bg-muted"
                >
                  <img
                    src={blobUrl(sha)}
                    alt=""
                    className="aspect-square w-full object-cover transition-transform hover:scale-[1.02]"
                  />
                </button>
              ))
            : Array.from({ length: count }, (_, i) => (
                <div
                  key={i}
                  className={clsx(
                    'flex aspect-square items-center justify-center rounded-xl border border-line bg-muted',
                    'animate-pulse',
                  )}
                >
                  <Spinner />
                </div>
              ))}
        </div>
      )}
    </div>
  )
}
