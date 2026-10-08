import clsx from 'clsx'
import {
  AlertTriangle,
  AppWindow,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  Globe,
  ImageIcon,
  ListTodo,
  Loader2,
  Monitor,
  Search,
  ShieldQuestion,
  Terminal,
  X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { ApprovalDecision, ApprovalDTO } from '../../../shared/ipc'
import { blobUrl, invoke } from '../lib/api'
import { attempt } from '../store/app'
import { Button } from './ui'

export interface ToolResultPart {
  output: unknown
  isError?: boolean
  images?: { blob: string; mime: string }[]
}

type Input = Record<string, unknown>

const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))

const META: Record<string, { icon: ReactNode; summary: (i: Input) => string }> = {
  read_file: { icon: <FileText className="size-3.5" />, summary: (i) => `读取 ${s(i.path)}` },
  list_files: {
    icon: <FileSearch className="size-3.5" />,
    summary: (i) => `查找文件 ${s(i.pattern ?? i.path ?? '.')}`,
  },
  grep: { icon: <Search className="size-3.5" />, summary: (i) => `搜索 “${s(i.pattern)}”` },
  edit_file: { icon: <FilePen className="size-3.5" />, summary: (i) => `编辑 ${s(i.path)}` },
  write_file: { icon: <FilePlus className="size-3.5" />, summary: (i) => `写入 ${s(i.path)}` },
  bash: {
    icon: <Terminal className="size-3.5" />,
    summary: (i) =>
      `${i.unsandboxed ? '[沙箱外] ' : ''}${i.run_in_background ? '[后台] ' : ''}${s(i.command)}`,
  },
  bash_output: {
    icon: <Terminal className="size-3.5" />,
    summary: (i) =>
      i.job_id
        ? `读取 ${s(i.job_id)} 的输出${i.until ? `，等待 “${s(i.until)}”` : ''}`
        : '查看后台任务',
  },
  kill_job: { icon: <Terminal className="size-3.5" />, summary: (i) => `停止 ${s(i.job_id)}` },
  web_fetch: { icon: <Globe className="size-3.5" />, summary: (i) => `访问 ${s(i.url)}` },
  web_search: { icon: <Search className="size-3.5" />, summary: (i) => `搜索 “${s(i.query)}”` },
  generate_image: {
    icon: <ImageIcon className="size-3.5" />,
    summary: (i) => `生成图片：${s(i.prompt).slice(0, 60)}`,
  },
  todo_write: { icon: <ListTodo className="size-3.5" />, summary: () => '任务列表' },
  browser_navigate: {
    icon: <AppWindow className="size-3.5" />,
    summary: (i) => `打开 ${s(i.url)}`,
  },
  browser_snapshot: { icon: <AppWindow className="size-3.5" />, summary: () => '读取页面' },
  browser_click: { icon: <AppWindow className="size-3.5" />, summary: (i) => `点击 ${s(i.ref)}` },
  browser_type: {
    icon: <AppWindow className="size-3.5" />,
    summary: (i) => `在 ${s(i.ref)} 输入 “${s(i.text).slice(0, 40)}”`,
  },
  browser_select_option: {
    icon: <AppWindow className="size-3.5" />,
    summary: (i) => `在 ${s(i.ref)} 选择 “${s(i.value)}”`,
  },
  browser_press_key: {
    icon: <AppWindow className="size-3.5" />,
    summary: (i) => `按键 ${s(i.key)}`,
  },
  browser_scroll: {
    icon: <AppWindow className="size-3.5" />,
    summary: (i) => (i.direction === 'up' ? '向上滚动' : '向下滚动'),
  },
  browser_back: { icon: <AppWindow className="size-3.5" />, summary: () => '后退' },
  browser_screenshot: { icon: <AppWindow className="size-3.5" />, summary: () => '网页截图' },
  computer: { icon: <Monitor className="size-3.5" />, summary: (i) => computerSummary(i) },
}

function computerSummary(i: Input): string {
  const at = Array.isArray(i.coordinate) ? ` (${i.coordinate.join(', ')})` : ''
  switch (i.action) {
    case 'screenshot':
      return '截屏'
    case 'left_click':
      return `点击${at}`
    case 'double_click':
      return `双击${at}`
    case 'right_click':
      return `右键点击${at}`
    case 'type':
      return `输入 “${s(i.text).slice(0, 40)}”`
    case 'key':
      return `按键 ${s(i.text)}`
    case 'scroll':
      return `滚动${at}`
    case 'mouse_move':
      return `移动鼠标${at}`
    case 'left_click_drag':
      return `拖动到${at}`
    case 'wait':
      return '等待'
    default:
      return `电脑操作 ${s(i.action)}`
  }
}

function Screenshots({ images }: { images: { blob: string; mime: string }[] }) {
  return (
    <div className="flex flex-wrap gap-2 border-t border-line p-2">
      {images.map((img) => (
        <a key={img.blob} href={blobUrl(img.blob)} target="_blank" rel="noreferrer">
          <img
            src={blobUrl(img.blob)}
            alt="截图"
            className="max-h-64 rounded-md border border-line object-contain"
          />
        </a>
      ))}
    </div>
  )
}

export function toolSummary(name: string, input: unknown): string {
  try {
    return META[name]?.summary((input ?? {}) as Input) ?? name
  } catch {
    return name
  }
}

function Pre({ children, tone }: { children: ReactNode; tone?: 'add' | 'del' }) {
  return (
    <pre
      className={clsx(
        'max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all',
        tone === 'add' && 'bg-emerald-500/8 text-emerald-800 dark:text-emerald-300',
        tone === 'del' && 'bg-red-500/8 text-red-800 dark:text-red-300',
      )}
    >
      {children}
    </pre>
  )
}

const prefix = (text: string, mark: string) =>
  text
    .split('\n')
    .map((l) => `${mark} ${l}`)
    .join('\n')

function InputView({ name, input }: { name: string; input: Input }) {
  if (name === 'edit_file') {
    return (
      <div className="divide-y divide-line">
        <Pre tone="del">{prefix(s(input.old_string), '-')}</Pre>
        <Pre tone="add">{prefix(s(input.new_string), '+')}</Pre>
      </div>
    )
  }
  if (name === 'write_file') return <Pre tone="add">{s(input.content)}</Pre>
  if (name === 'bash') return <Pre>$ {s(input.command)}</Pre>
  return <Pre>{JSON.stringify(input, null, 2)}</Pre>
}

interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <div className="my-2 rounded-xl border border-line px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-fg-soft">
        <ListTodo className="size-3.5" />
        任务列表 · {todos.filter((t) => t.status === 'completed').length}/{todos.length}
      </div>
      <ul className="space-y-1 text-sm">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2">
            {t.status === 'completed' ? (
              <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            ) : t.status === 'in_progress' ? (
              <CircleDot className="mt-0.5 size-4 shrink-0 text-accent" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-fg-faint" />
            )}
            <span className={clsx(t.status === 'completed' && 'text-fg-faint line-through')}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ToolCall({
  name,
  input,
  result,
  approval,
  running,
}: {
  name: string
  input: unknown
  result?: ToolResultPart
  approval?: ApprovalDTO
  /** The run is still going, so a call without result is in progress. */
  running: boolean
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const inp = (input ?? {}) as Input

  if (name === 'todo_write' && Array.isArray(inp.todos))
    return <TodoList todos={inp.todos as Todo[]} />

  const status: 'pending' | 'waiting' | 'ok' | 'error' | 'interrupted' = approval
    ? 'waiting'
    : result
      ? result.isError
        ? 'error'
        : 'ok'
      : running
        ? 'pending'
        : 'interrupted'

  const decide = async (decision: ApprovalDecision) => {
    if (!approval) return
    setBusy(true)
    await attempt(() =>
      invoke('chat.approve', {
        conversationId: approval.conversationId,
        toolCallId: approval.toolCallId,
        decision,
      }),
    )
    setBusy(false)
  }

  const meta = META[name]
  const expanded = open || status === 'waiting'

  return (
    <div
      className={clsx(
        'my-1.5 overflow-hidden rounded-xl border text-sm',
        status === 'waiting'
          ? approval?.danger
            ? 'border-red-500/50'
            : 'border-amber-500/50'
          : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60"
      >
        <span className="text-fg-faint">{meta?.icon ?? <Terminal className="size-3.5" />}</span>
        <span
          className={clsx('min-w-0 flex-1 truncate', name === 'bash' && 'font-mono text-[12.5px]')}
        >
          {toolSummary(name, input)}
        </span>
        {status === 'pending' && <Loader2 className="size-3.5 animate-spin text-fg-faint" />}
        {status === 'waiting' && <ShieldQuestion className="size-3.5 text-amber-600" />}
        {status === 'ok' && <Check className="size-3.5 text-emerald-600" />}
        {status === 'error' && <X className="size-3.5 text-red-600" />}
        {status === 'interrupted' && <span className="text-xs text-fg-faint">未执行</span>}
        <ChevronRight
          className={clsx('size-3.5 text-fg-faint transition-transform', expanded && 'rotate-90')}
        />
      </button>

      {expanded && (
        <div className="border-t border-line bg-muted/30">
          <InputView name={name} input={inp} />
          {result && (
            <div className="border-t border-line">
              <Pre>{s(result.output)}</Pre>
            </div>
          )}
          {result?.images?.length ? <Screenshots images={result.images} /> : null}
        </div>
      )}

      {approval && (
        <div
          className={clsx(
            'flex flex-wrap items-center gap-2 border-t px-3 py-2',
            approval.danger
              ? 'border-red-500/30 bg-red-500/6'
              : 'border-amber-500/30 bg-amber-500/6',
          )}
        >
          {approval.danger && <AlertTriangle className="size-4 text-red-600" />}
          <span className="min-w-0 flex-1 text-xs text-fg-soft">需要确认：{approval.reason}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('deny')}>
            拒绝
          </Button>
          {!approval.danger && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void decide('allow-always')}
              title="本次会话中同类操作不再询问"
            >
              总是允许
            </Button>
          )}
          <Button
            size="sm"
            variant={approval.danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => void decide('allow')}
          >
            允许
          </Button>
        </div>
      )}
    </div>
  )
}
