import clsx from 'clsx'
import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Pencil,
  RotateCcw,
  Undo2,
} from 'lucide-react'
import { memo, useState } from 'react'
import type { MessagePart } from '@aitech/core'
import type { ApprovalDTO, Attachment, MessageDTO } from '../../../shared/ipc'
import { blobUrl } from '../lib/api'
import { formatTokens } from '../lib/format'
import { AttachmentChip } from './Composer'
import { CopyButton, Markdown } from './Markdown'
import { ToolCall, type ToolResultPart } from './ToolCall'
import { Button, Textarea } from './ui'

const textOf = (parts: MessagePart[]) =>
  parts
    .map((p) =>
      p.type === 'text'
        ? p.text
        : p.type === 'command'
          ? `/${p.name}${p.args ? ` ${p.args}` : ''}`
          : '',
    )
    .join('')

function attachmentsOf(parts: MessagePart[]): Attachment[] {
  return parts.flatMap((p) =>
    p.type === 'image' || p.type === 'file'
      ? [{ blob: p.blob, mime: p.mime, name: p.name ?? 'image' }]
      : [],
  )
}

interface BranchProps {
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
}

function BranchNav({ index, total, onPrev, onNext }: BranchProps) {
  if (total <= 1) return null
  return (
    <div className="flex items-center text-xs text-fg-faint">
      <button
        type="button"
        className="rounded p-1 hover:bg-muted hover:text-fg disabled:opacity-30"
        disabled={index === 0}
        onClick={onPrev}
        aria-label="上一个版本"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="tabular-nums">
        {index + 1} / {total}
      </span>
      <button
        type="button"
        className="rounded p-1 hover:bg-muted hover:text-fg disabled:opacity-30"
        disabled={index === total - 1}
        onClick={onNext}
        aria-label="下一个版本"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  )
}

const actionBtn = 'rounded-md p-1.5 text-fg-faint hover:bg-muted hover:text-fg disabled:opacity-30'

export const UserMessage = memo(function UserMessage({
  message,
  branch,
  busy,
  onEdit,
  onRewind,
}: {
  message: MessageDTO
  branch: BranchProps
  busy: boolean
  onEdit: (text: string, attachments: Attachment[]) => Promise<boolean>
  /** Undo the agent's file changes after this message; absent when there are none. */
  onRewind?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const text = textOf(message.parts)
  const attachments = attachmentsOf(message.parts)
  const [draft, setDraft] = useState(text)

  if (editing) {
    return (
      <div className="ml-auto w-full max-w-[85%]">
        <Textarea
          autoFocus
          rows={Math.min(10, Math.max(2, draft.split('\n').length))}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
          }}
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            取消
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || (!draft.trim() && !attachments.length)}
            onClick={async () => {
              if (await onEdit(draft, attachments)) setEditing(false)
            }}
          >
            发送
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="group flex flex-col items-end">
      {attachments.length > 0 && (
        <div className="mb-2 flex max-w-[85%] flex-wrap justify-end gap-2">
          {attachments.map((a) =>
            a.mime.startsWith('image/') ? (
              <a key={a.blob} href={blobUrl(a.blob)} target="_blank" rel="noreferrer">
                <img
                  src={blobUrl(a.blob)}
                  alt={a.name}
                  className="max-h-48 max-w-64 rounded-xl border border-line object-cover"
                />
              </a>
            ) : (
              <AttachmentChip key={a.blob} attachment={a} />
            ),
          )}
        </div>
      )}
      {text && (
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      )}
      <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 has-[:focus-visible]:opacity-100">
        <BranchNav {...branch} />
        <CopyButton text={text} className={actionBtn} />
        <button
          type="button"
          className={actionBtn}
          title="编辑"
          disabled={busy}
          onClick={() => {
            setDraft(text)
            setEditing(true)
          }}
        >
          <Pencil className="size-3.5" />
        </button>
        {onRewind && (
          <button
            type="button"
            className={actionBtn}
            title="撤销这之后的文件改动"
            disabled={busy}
            onClick={onRewind}
          >
            <Undo2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
})

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const expanded = open || streaming
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm text-fg-faint hover:text-fg-soft"
      >
        <Brain className="size-3.5" />
        {streaming ? '思考中…' : '思考过程'}
        <ChevronDown className={clsx('size-3.5 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="mt-2 border-l-2 border-line pl-3 text-sm leading-relaxed whitespace-pre-wrap text-fg-soft">
          {text}
        </div>
      )}
    </div>
  )
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  branch,
  busy,
  onRegenerate,
  results,
  approvals,
  endOfTurn,
}: {
  message: MessageDTO
  branch: BranchProps
  busy: boolean
  onRegenerate: () => void
  results: Map<string, ToolResultPart>
  approvals: Record<string, ApprovalDTO>
  /** Last message of an agent turn: show the action row. */
  endOfTurn: boolean
}) {
  const streaming = message.status === 'streaming'
  const text = textOf(message.parts)
  const reasoning = message.parts.find((p) => p.type === 'reasoning')
  const toolCalls = message.parts.filter((p) => p.type === 'tool_call')
  const thinkingOnly = streaming && !text && !!reasoning

  return (
    <div className="group">
      {reasoning && reasoning.type === 'reasoning' && (
        <Reasoning text={reasoning.text} streaming={thinkingOnly} />
      )}
      {text ? (
        <div className={clsx(streaming && 'streaming')}>
          <Markdown text={text} />
        </div>
      ) : (
        streaming && !reasoning && <div className="streaming-caret h-6" />
      )}
      {toolCalls.length > 0 && (
        <div className={clsx(text && 'mt-2')}>
          {toolCalls.map((t) =>
            t.type === 'tool_call' ? (
              <ToolCall
                key={t.id}
                name={t.name}
                input={t.input}
                conversationId={message.conversationId}
                result={results.get(t.id)}
                approval={
                  approvals[t.id]?.conversationId === message.conversationId && endOfTurn
                    ? approvals[t.id]
                    : undefined
                }
                running={busy}
              />
            ) : null,
          )}
        </div>
      )}
      {message.status === 'error' && (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-all">{message.error || '生成失败'}</span>
        </div>
      )}
      {message.status === 'aborted' && <div className="mt-2 text-xs text-fg-faint">已停止</div>}

      {!streaming && endOfTurn && (
        <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 has-[:focus-visible]:opacity-100">
          <BranchNav {...branch} />
          {text && <CopyButton text={text} className={actionBtn} />}
          <button
            type="button"
            className={actionBtn}
            title="重新生成"
            disabled={busy}
            onClick={onRegenerate}
          >
            <RotateCcw className="size-3.5" />
          </button>
          <span className="ml-2 text-[11px] text-fg-faint">
            {message.modelId}
            {message.usage &&
              ` · ${formatTokens(message.usage.inputTokens)} → ${formatTokens(message.usage.outputTokens)} tokens`}
            {!!message.usage?.cacheReadTokens &&
              `（缓存命中 ${formatTokens(message.usage.cacheReadTokens)}）`}
          </span>
        </div>
      )}
    </div>
  )
})
