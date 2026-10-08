import clsx from 'clsx'
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  Loader2,
  ShieldQuestion,
  Terminal,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MessagePart } from '@aitech/core'
import { Composer, type ImageDraft } from '../components/Composer'
import { Markdown } from '../components/Markdown'
import { Button, Header, Spinner } from '../components/ui'
import { activePath, type RApproval, type RMessage } from '../lib/types'
import { attempt, useApp } from '../store/app'

const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''))

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'bash':
      return s(input.command)
    case 'read_file':
      return `读取 ${s(input.path)}`
    case 'write_file':
      return `写入 ${s(input.path)}`
    case 'edit_file':
      return `编辑 ${s(input.path)}`
    case 'list_files':
      return `查找文件 ${s(input.pattern ?? input.path ?? '.')}`
    case 'grep':
      return `搜索 “${s(input.pattern)}”`
    case 'web_fetch':
      return `访问 ${s(input.url)}`
    case 'generate_image':
      return `生成图片`
    case 'todo_write':
      return '更新任务列表'
    default:
      return name
  }
}

export function RemoteConversationScreen({
  desktopId,
  conversationId,
}: {
  desktopId: string
  conversationId: string
}) {
  const { desktops, remote, loadConversation, hub } = useApp()
  const desktop = desktops.find((d) => d.deviceId === desktopId)
  const st = remote[desktopId]
  const detail = st?.conversations[conversationId]
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setError(null)
    loadConversation(desktopId, conversationId).catch((e: Error) => setError(e.message))
  }, [desktopId, conversationId, loadConversation])

  const path = useMemo(
    () => (detail ? activePath(detail.messages, detail.conversation.activeLeafId) : []),
    [detail],
  )
  const running = !!st?.running.has(conversationId)
  const approvals = Object.values(st?.approvals ?? {}).filter(
    (a) => a.conversationId === conversationId,
  )
  const project = st?.sync?.projects.find((p) => p.id === detail?.conversation.projectId)

  // Results follow their assistant step in tool messages.
  const results = useMemo(() => {
    const map = new Map<string, Extract<MessagePart, { type: 'tool_result' }>>()
    path.forEach((m, i) => {
      if (m.role !== 'assistant') return
      for (const t of path.slice(i + 1)) {
        if (t.role !== 'tool') break
        for (const p of t.parts) if (p.type === 'tool_result') map.set(`${m.id}:${p.id}`, p)
      }
    })
    return map
  }, [path])

  const lastLen = path.length ? JSON.stringify(path.at(-1)!.parts).length : 0
  useLayoutEffect(() => {
    const el = document.scrollingElement
    if (el) el.scrollTop = el.scrollHeight
  }, [path.length, lastLen, approvals.length])

  if (!desktop) return <Header title="电脑不存在" backTo="/" />

  const send = async (text: string, images: ImageDraft[]) => {
    if (!hub) return false
    const ok = await attempt(() =>
      hub.rpc(desktop, 'chat.send', {
        conversationId,
        text,
        images: images.map((i) => ({ data: i.data, mime: i.mime, name: i.name })),
      }),
    )
    return ok !== undefined
  }

  return (
    <div className="flex flex-1 flex-col">
      <Header
        title={detail?.conversation.title || '新任务'}
        subtitle={[desktop.name, project?.name].filter(Boolean).join(' · ')}
        backTo={`/d/${desktopId}`}
      />
      <div ref={scroller} className="flex-1 space-y-4 px-4 py-4">
        {error && (
          <div className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        {!detail && !error && (
          <div className="flex justify-center p-10">
            <Spinner />
          </div>
        )}
        {detail && path.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-fg-faint">
            {project ? `描述你想让 AI 在「${project.name}」里完成的任务。` : '发送消息开始对话。'}
          </div>
        )}
        {path.map((m) =>
          m.role === 'user' ? (
            <UserBubble key={m.id} message={m} />
          ) : m.role === 'assistant' ? (
            <AssistantBlock
              key={m.id}
              message={m}
              running={running}
              result={(id) => results.get(`${m.id}:${id}`)}
              approval={(id) => approvals.find((a) => a.toolCallId === id)}
              onDecide={async (a, decision) => {
                if (!hub) return
                await attempt(() =>
                  hub.rpc(desktop, 'chat.approve', {
                    conversationId,
                    toolCallId: a.toolCallId,
                    decision,
                  }),
                )
              }}
            />
          ) : null,
        )}
        {running && path.at(-1)?.role !== 'assistant' && (
          <div className="flex items-center gap-2 text-sm text-fg-faint">
            <Loader2 className="size-4 animate-spin" />
            处理中…
          </div>
        )}
      </div>
      <div className="sticky bottom-0">
        <Composer
          placeholder={project ? '描述任务…' : '输入消息…'}
          running={running}
          disabled={!detail}
          onSend={send}
          onStop={() =>
            hub && void attempt(() => hub.rpc(desktop, 'chat.stop', { conversationId }))
          }
        />
      </div>
    </div>
  )
}

function UserBubble({ message }: { message: RMessage }) {
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  const images = message.parts.filter((p) => p.type === 'image').length
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-accent px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-white">
        {images > 0 && <div className="mb-1 text-xs opacity-80">[{images} 张图片]</div>}
        {text}
      </div>
    </div>
  )
}

function AssistantBlock({
  message,
  running,
  result,
  approval,
  onDecide,
}: {
  message: RMessage
  running: boolean
  result: (toolCallId: string) => Extract<MessagePart, { type: 'tool_result' }> | undefined
  approval: (toolCallId: string) => RApproval | undefined
  onDecide: (a: RApproval, decision: 'allow' | 'deny' | 'allow-always') => Promise<void>
}) {
  const [showThinking, setShowThinking] = useState(false)
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  const reasoning = message.parts.find((p) => p.type === 'reasoning')
  const calls = message.parts.filter((p) => p.type === 'tool_call')
  const streaming = message.status === 'streaming'

  return (
    <div className="space-y-2">
      {reasoning?.type === 'reasoning' && (
        <div>
          <button
            type="button"
            onClick={() => setShowThinking((v) => !v)}
            className="flex items-center gap-1 text-[13px] text-fg-faint"
          >
            <Brain className="size-3.5" />
            {streaming && !text ? '思考中…' : '思考过程'}
            <ChevronDown className={clsx('size-3.5', showThinking && 'rotate-180')} />
          </button>
          {showThinking && (
            <div className="mt-1 border-l-2 border-line pl-3 text-[13px] whitespace-pre-wrap text-fg-soft">
              {reasoning.text}
            </div>
          )}
        </div>
      )}
      {text && <Markdown text={text} />}
      {streaming && !text && !reasoning && (
        <Loader2 className="size-4 animate-spin text-fg-faint" />
      )}
      {calls.map((c) =>
        c.type === 'tool_call' ? (
          <ToolRow
            key={c.id}
            name={c.name}
            input={(c.input ?? {}) as Record<string, unknown>}
            result={result(c.id)}
            approval={approval(c.id)}
            running={running}
            onDecide={onDecide}
          />
        ) : null,
      )}
      {message.status === 'error' && (
        <div className="flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-all">{message.error || '生成失败'}</span>
        </div>
      )}
      {message.status === 'aborted' && <div className="text-xs text-fg-faint">已停止</div>}
    </div>
  )
}

function ToolRow({
  name,
  input,
  result,
  approval,
  running,
  onDecide,
}: {
  name: string
  input: Record<string, unknown>
  result?: Extract<MessagePart, { type: 'tool_result' }>
  approval?: RApproval
  running: boolean
  onDecide: (a: RApproval, decision: 'allow' | 'deny' | 'allow-always') => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  if (name === 'todo_write' && Array.isArray(input.todos)) {
    const todos = input.todos as { content: string; status: string }[]
    return (
      <div className="rounded-xl border border-line bg-surface px-3 py-2 text-sm">
        {todos.map((t, i) => (
          <div
            key={i}
            className={clsx(
              'flex gap-2 py-0.5',
              t.status === 'completed' && 'text-fg-faint line-through',
            )}
          >
            <span>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}</span>
            {t.content}
          </div>
        ))}
      </div>
    )
  }

  const decide = async (d: 'allow' | 'deny' | 'allow-always') => {
    if (!approval) return
    setBusy(true)
    await onDecide(approval, d)
    setBusy(false)
  }

  return (
    <div
      className={clsx(
        'overflow-hidden rounded-xl border bg-surface',
        approval ? (approval.danger ? 'border-red-500/50' : 'border-amber-500/50') : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Terminal className="size-4 shrink-0 text-fg-faint" />
        <span
          className={clsx('min-w-0 flex-1 truncate text-[13px]', name === 'bash' && 'font-mono')}
        >
          {toolSummary(name, input)}
        </span>
        {approval ? (
          <ShieldQuestion className="size-4 text-amber-600" />
        ) : result ? (
          result.isError ? (
            <X className="size-4 text-red-600" />
          ) : (
            <Check className="size-4 text-emerald-600" />
          )
        ) : running ? (
          <Loader2 className="size-4 animate-spin text-fg-faint" />
        ) : null}
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto border-t border-line bg-muted/50 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap break-all">
          {name === 'edit_file'
            ? `- ${s(input.old_string)}\n+ ${s(input.new_string)}`
            : name === 'write_file'
              ? s(input.content)
              : JSON.stringify(input, null, 2)}
          {result && `\n\n${s(result.output)}`}
        </pre>
      )}
      {approval && (
        <div className="border-t border-amber-500/30 bg-amber-500/8 px-3 py-2.5">
          <div className="mb-2 text-xs text-fg-soft">需要确认：{approval.reason}</div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="h-10 flex-1"
              disabled={busy}
              onClick={() => void decide('deny')}
            >
              拒绝
            </Button>
            {!approval.danger && (
              <Button
                variant="secondary"
                className="h-10 flex-1"
                disabled={busy}
                onClick={() => void decide('allow-always')}
              >
                总是允许
              </Button>
            )}
            <Button
              variant={approval.danger ? 'danger' : 'primary'}
              className="h-10 flex-1"
              disabled={busy}
              onClick={() => void decide('allow')}
            >
              允许
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
