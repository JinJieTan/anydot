import clsx from 'clsx'
import { Folder, MessageSquare, Plus, RefreshCw, ShieldQuestion } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Header, Spinner } from '../components/ui'
import { go } from '../lib/router'
import type { RConversation } from '../lib/types'
import { attempt, useApp } from '../store/app'

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function DesktopScreen({ desktopId }: { desktopId: string }) {
  const { desktops, remote, refresh, hub } = useApp()
  const desktop = desktops.find((d) => d.deviceId === desktopId)
  const st = remote[desktopId]
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)

  useEffect(() => {
    void refresh(desktopId)
  }, [desktopId, refresh])

  if (!desktop) return <Header title="电脑不存在" backTo="/" />

  const projects = st?.sync?.projects ?? []
  const conversations = st?.sync?.conversations ?? []
  const approvals = Object.values(st?.approvals ?? {})
  const byProject = (pid: string | null) => conversations.filter((c) => c.projectId === pid)

  const newTask = async (projectId: string | null) => {
    if (!hub) return
    setCreating(projectId ?? 'chat')
    const conv = await attempt(() =>
      hub.rpc<RConversation>(desktop, 'conversation.create', { projectId }),
    )
    setCreating(null)
    if (conv) go(`/d/${desktopId}/c/${conv.id}`)
  }

  return (
    <div className="pb-8">
      <Header
        title={desktop.name}
        subtitle={st?.online ? '在线' : st?.online === false ? (st.error ?? '离线') : '连接中…'}
        backTo="/"
        right={
          <button
            type="button"
            aria-label="刷新"
            onClick={async () => {
              setRefreshing(true)
              await refresh(desktopId)
              setRefreshing(false)
            }}
            className="flex size-10 items-center justify-center rounded-full active:bg-muted"
          >
            <RefreshCw className={clsx('size-5', refreshing && 'animate-spin')} />
          </button>
        }
      />

      {!st?.sync ? (
        <div className="flex justify-center p-10">
          {st?.online === false ? (
            <div className="text-center text-sm text-fg-soft">
              {st.error ?? '电脑不在线'}
              <div className="mt-1 text-xs text-fg-faint">请确认电脑已开机，且 aitech 正在运行</div>
            </div>
          ) : (
            <Spinner />
          )}
        </div>
      ) : (
        <div className="space-y-6 p-4">
          {approvals.length > 0 && (
            <section>
              <h2 className="mb-2 px-1 text-[13px] font-medium text-amber-700 dark:text-amber-400">
                需要你确认
              </h2>
              <div className="space-y-2">
                {approvals.map((a) => (
                  <button
                    key={a.toolCallId}
                    type="button"
                    onClick={() => go(`/d/${desktopId}/c/${a.conversationId}`)}
                    className="flex w-full items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/8 p-3.5 text-left"
                  >
                    <ShieldQuestion className="size-5 shrink-0 text-amber-600" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                      {a.summary}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {projects.map((p) => (
            <section key={p.id}>
              <div className="mb-2 flex items-center gap-2 px-1">
                <Folder className="size-4 text-fg-faint" />
                <h2 className="flex-1 truncate text-[13px] font-medium text-fg-soft">{p.name}</h2>
                <Button
                  variant="secondary"
                  className="h-8 rounded-lg px-2.5 text-[13px]"
                  loading={creating === p.id}
                  onClick={() => void newTask(p.id)}
                >
                  <Plus className="size-4" />
                  新任务
                </Button>
              </div>
              <ConversationList
                desktopId={desktopId}
                items={byProject(p.id).slice(0, 8)}
                running={st.running}
              />
            </section>
          ))}

          <section>
            <div className="mb-2 flex items-center gap-2 px-1">
              <MessageSquare className="size-4 text-fg-faint" />
              <h2 className="flex-1 text-[13px] font-medium text-fg-soft">对话</h2>
              <Button
                variant="secondary"
                className="h-8 rounded-lg px-2.5 text-[13px]"
                loading={creating === 'chat'}
                onClick={() => void newTask(null)}
              >
                <Plus className="size-4" />
                新对话
              </Button>
            </div>
            <ConversationList
              desktopId={desktopId}
              items={byProject(null).slice(0, 20)}
              running={st.running}
            />
          </section>
        </div>
      )}
    </div>
  )
}

function ConversationList({
  desktopId,
  items,
  running,
}: {
  desktopId: string
  items: RConversation[]
  running: Set<string>
}) {
  if (!items.length)
    return (
      <div className="rounded-2xl border border-dashed border-line px-4 py-5 text-center text-sm text-fg-faint">
        暂无
      </div>
    )
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      {items.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => go(`/d/${desktopId}/c/${c.id}`)}
          className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 active:bg-muted"
        >
          {running.has(c.id) && (
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />
          )}
          <span className="min-w-0 flex-1 truncate text-[15px]">{c.title || '新对话'}</span>
          <span className="shrink-0 text-xs text-fg-faint">{timeAgo(c.updatedAt)}</span>
        </button>
      ))}
    </div>
  )
}
