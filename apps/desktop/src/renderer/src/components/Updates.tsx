import { ArrowDownCircle, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { UpdateStatusDTO } from '../../../shared/ipc'
import { api, invoke } from '../lib/api'
import { succeeded } from '../store/app'

export function useUpdateStatus(): UpdateStatusDTO | null {
  const [status, setStatus] = useState<UpdateStatusDTO | null>(null)
  useEffect(() => {
    void invoke('updates.status').then(setStatus)
    return api.on('update', setStatus)
  }, [])
  return status
}

/** Shown above the sidebar footer once a newer version exists. */
export function UpdateBanner() {
  const status = useUpdateStatus()
  if (!status?.version) return null
  const { state, version, progress } = status
  if (state !== 'available' && state !== 'downloading' && state !== 'ready') return null

  const downloading = state === 'downloading'
  return (
    <button
      type="button"
      disabled={downloading}
      onClick={() => void succeeded(() => invoke('updates.install'))}
      title={state === 'ready' ? '重启 AnyDot 并安装新版本' : undefined}
      className="mb-1 flex h-9 w-full items-center gap-2.5 rounded-lg bg-accent/10 px-2.5 text-sm text-accent transition-colors hover:bg-accent/15 disabled:cursor-default disabled:hover:bg-accent/10"
    >
      {state === 'ready' ? (
        <RotateCw className="size-4 shrink-0" />
      ) : (
        <ArrowDownCircle className="size-4 shrink-0" />
      )}
      <span className="flex-1 truncate text-left font-medium">新版本 v{version}</span>
      <span className="shrink-0 text-xs">
        {downloading ? `下载中 ${progress ?? 0}%` : state === 'ready' ? '重启更新' : '下载'}
      </span>
    </button>
  )
}

const STATE_TEXT: Record<UpdateStatusDTO['state'], string> = {
  unsupported: '开发版本不检查更新',
  idle: '',
  checking: '正在检查…',
  latest: '已是最新版本',
  available: '有新版本可以下载',
  downloading: '正在下载新版本',
  ready: '新版本已下载，重启即可更新',
  error: '检查更新失败',
}

/** Version row on the About page. */
export function UpdateCheck() {
  const status = useUpdateStatus()
  if (!status) return null
  const busy = status.state === 'checking' || status.state === 'downloading'
  const text =
    status.state === 'downloading'
      ? `正在下载 v${status.version}（${status.progress ?? 0}%）`
      : status.version && (status.state === 'available' || status.state === 'ready')
        ? `${STATE_TEXT[status.state]}：v${status.version}`
        : STATE_TEXT[status.state]
  return (
    <div className="flex items-center gap-3">
      {status.state === 'available' || status.state === 'ready' ? (
        <button
          type="button"
          onClick={() => void succeeded(() => invoke('updates.install'))}
          className="h-7 rounded-lg bg-accent px-3 text-xs font-medium text-white hover:opacity-90"
        >
          {status.state === 'ready' ? '重启更新' : '下载新版本'}
        </button>
      ) : (
        <button
          type="button"
          disabled={busy || status.state === 'unsupported'}
          onClick={() => void invoke('updates.check')}
          className="h-7 rounded-lg border border-line px-3 text-xs hover:bg-muted disabled:opacity-50"
        >
          检查更新
        </button>
      )}
      <span className="text-xs text-fg-soft" title={status.error ?? undefined}>
        {text}
      </span>
    </div>
  )
}
