import clsx from 'clsx'
import { ChevronRight, GitBranch, RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FileChangeDTO, Rpc } from '../../../shared/ipc'
import { api, invoke } from '../lib/api'
import { useArtifact } from '../lib/artifact'
import { useApp } from '../store/app'

type Changes = Awaited<ReturnType<Rpc['git.changes']>>

const btn = 'rounded-md p-1.5 text-fg-faint hover:bg-muted hover:text-fg'

const STATUS: Record<FileChangeDTO['status'], { label: string; className: string }> = {
  M: { label: 'M', className: 'text-amber-600' },
  A: { label: 'A', className: 'text-emerald-600' },
  '?': { label: 'U', className: 'text-emerald-600' },
  D: { label: 'D', className: 'text-red-600' },
  R: { label: 'R', className: 'text-sky-600' },
}

/** Side panel: uncommitted git changes in the folder a conversation's agent works in. */
export function ChangesPanel({ conversationId }: { conversationId: string }) {
  const close = useArtifact((s) => s.close)
  const [data, setData] = useState<Changes | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const running = useApp((s) => s.running.has(conversationId))

  const load = useCallback(
    () =>
      invoke('git.changes', conversationId).then(
        (d) => {
          setData(d)
          setError(null)
        },
        (err: Error) => setError(err.message),
      ),
    [conversationId],
  )

  // Refresh after each tool result while the agent works, and when the run ends.
  useEffect(() => {
    void load()
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api.on('chat', (e) => {
      if (e.type === 'message' && e.conversationId === conversationId) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void load(), 500)
      }
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load, conversationId, running, reloads])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const total = data?.files.reduce(
    (t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }),
    { add: 0, del: 0 },
  )

  return (
    <aside className="flex w-[46%] min-w-[360px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-12 items-center gap-2 border-b border-line px-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">改动</div>
        </div>
        {data?.branch && (
          <span
            className="flex min-w-0 items-center gap-1 truncate rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-fg-soft"
            title={data.folder}
          >
            <GitBranch className="size-3 shrink-0" />
            {data.branch}
          </span>
        )}
        {total && data && data.files.length > 0 && (
          <span className="shrink-0 font-mono text-xs">
            <span className="text-emerald-600">+{total.add}</span>{' '}
            <span className="text-red-600">−{total.del}</span>
          </span>
        )}
        <button type="button" className={btn} title="刷新" onClick={() => setReloads((n) => n + 1)}>
          <RotateCw className="size-3.5" />
        </button>
        <button type="button" className={btn} title="关闭（Esc）" onClick={close}>
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-4 text-sm text-red-600">{error}</p>
        ) : !data ? null : !data.repo ? (
          <p className="p-4 text-sm text-fg-soft">这个文件夹不是 git 仓库，无法显示改动。</p>
        ) : data.files.length === 0 ? (
          <p className="p-4 text-sm text-fg-faint">没有未提交的改动</p>
        ) : (
          <ul>
            {data.files.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                conversationId={conversationId}
                expanded={open === f.path}
                version={reloads}
                onToggle={() => setOpen((cur) => (cur === f.path ? null : f.path))}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function FileRow({
  file,
  conversationId,
  expanded,
  version,
  onToggle,
}: {
  file: FileChangeDTO
  conversationId: string
  expanded: boolean
  version: number
  onToggle: () => void
}) {
  const [diff, setDiff] = useState<string | null>(null)
  const stat = `${file.additions}:${file.deletions}`
  useEffect(() => {
    if (!expanded) return
    let live = true
    void invoke('git.diff', { conversationId, path: file.path }).then(
      (d) => live && setDiff(d),
      (err: Error) => live && setDiff(err.message),
    )
    return () => {
      live = false
    }
  }, [expanded, conversationId, file.path, stat, version])

  const s = STATUS[file.status]
  const slash = file.path.lastIndexOf('/')
  return (
    <li className="border-b border-line">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/60"
      >
        <ChevronRight
          className={clsx(
            'size-3.5 shrink-0 text-fg-faint transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <span className={clsx('w-3 shrink-0 font-mono text-xs font-semibold', s.className)}>
          {s.label}
        </span>
        <span className="min-w-0 flex-1 truncate" title={file.path}>
          {file.path.slice(slash + 1)}
          {slash > 0 && (
            <span className="ml-2 text-xs text-fg-faint">{file.path.slice(0, slash)}</span>
          )}
        </span>
        <span className="shrink-0 font-mono text-xs">
          {file.additions > 0 && <span className="text-emerald-600">+{file.additions}</span>}{' '}
          {file.deletions > 0 && <span className="text-red-600">−{file.deletions}</span>}
        </span>
      </button>
      {expanded && diff !== null && <DiffView diff={diff} />}
    </li>
  )
}

function DiffView({ diff }: { diff: string }) {
  // Skip the git header up to the first hunk.
  const lines = diff.split('\n')
  const start = lines.findIndex((l) => l.startsWith('@@'))
  const body = start < 0 ? lines : lines.slice(start)
  if (start < 0 && /Binary files/.test(diff))
    return <p className="px-4 pb-3 text-xs text-fg-faint">二进制文件</p>
  return (
    <pre className="overflow-x-auto bg-code py-1 font-mono text-[12px] leading-[1.55]">
      {body.map((l, i) => (
        <div
          key={i}
          className={clsx(
            'px-3 whitespace-pre',
            l.startsWith('+') && 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300',
            l.startsWith('-') && 'bg-red-500/12 text-red-800 dark:text-red-300',
            l.startsWith('@@') && 'text-sky-700 dark:text-sky-400',
          )}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}
