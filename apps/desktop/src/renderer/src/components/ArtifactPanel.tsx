import clsx from 'clsx'
import { Code2, ExternalLink, Eye, RotateCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { invoke } from '../lib/api'
import { artifactPage, useArtifact } from '../lib/artifact'
import { attempt } from '../store/app'
import { CopyButton, Markdown } from './Markdown'

const btn = 'rounded-md p-1.5 text-fg-faint hover:bg-muted hover:text-fg'

function useDark() {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const [dark, setDark] = useState(query.matches)
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setDark(e.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [query])
  return dark
}

/** Side panel showing an HTML / SVG / Mermaid / Markdown artifact next to the chat. */
export function ArtifactPanel() {
  const { artifact, open, close } = useArtifact()
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [url, setUrl] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const dark = useDark()

  const page = artifact && artifact.kind !== 'markdown' ? artifactPage(artifact, dark) : null
  useEffect(() => {
    if (page === null) return
    let live = true
    void invoke('artifact.url', page).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [page])

  useEffect(() => {
    if (!artifact) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [artifact, close])

  if (!artifact) return null

  const reload = async () => {
    if (artifact.file) {
      const res = await attempt(() => invoke('artifact.readFile', artifact.file!))
      if (res) open({ ...artifact, content: res.content })
    }
    setReloads((n) => n + 1)
  }

  return (
    <aside className="flex w-[46%] min-w-[360px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-12 items-center gap-1 border-b border-line px-3">
        <div className="min-w-0 flex-1 truncate text-sm font-medium" title={artifact.file?.path}>
          {artifact.title}
        </div>
        <div className="mr-1 flex rounded-lg bg-muted p-0.5 text-xs">
          {(['preview', 'code'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={clsx(
                'flex items-center gap-1 rounded-md px-2 py-1',
                tab === t ? 'bg-surface shadow-sm' : 'text-fg-soft hover:text-fg',
              )}
            >
              {t === 'preview' ? <Eye className="size-3.5" /> : <Code2 className="size-3.5" />}
              {t === 'preview' ? '预览' : '代码'}
            </button>
          ))}
        </div>
        <button type="button" className={btn} title="重新加载" onClick={() => void reload()}>
          <RotateCw className="size-3.5" />
        </button>
        <CopyButton text={artifact.content} className={btn} />
        {page !== null && (
          <button
            type="button"
            className={btn}
            title="在独立窗口中打开"
            onClick={() => void invoke('preview.html', page)}
          >
            <ExternalLink className="size-3.5" />
          </button>
        )}
        <button type="button" className={btn} title="关闭（Esc）" onClick={close}>
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'code' ? (
          <pre className="p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
            {artifact.content}
          </pre>
        ) : artifact.kind === 'markdown' ? (
          <div className="px-6 py-5">
            <Markdown text={artifact.content} />
          </div>
        ) : url ? (
          <iframe
            key={`${url}:${reloads}`}
            src={url}
            title={artifact.title}
            sandbox="allow-scripts allow-popups allow-forms allow-modals"
            className="size-full border-0 bg-white"
          />
        ) : null}
      </div>
    </aside>
  )
}
