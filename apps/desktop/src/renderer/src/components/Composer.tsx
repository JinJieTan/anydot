import clsx from 'clsx'
import { ArrowUp, FileText, Folder, Paperclip, Sparkles, Square, Terminal, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Attachment, CommandDTO } from '../../../shared/ipc'
import { blobUrl, invoke } from '../lib/api'
import { guessMime, readFileAsBytes } from '../lib/format'
import { attempt } from '../store/app'
import { IconButton, Spinner } from './ui'

export interface ComposerProps {
  running: boolean
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean> | boolean
  onStop?: () => void
  placeholder?: string
  autoFocus?: boolean
  /** Extra controls rendered in the toolbar, e.g. model picker. */
  toolbar?: ReactNode
  /** Enables @-mentions of its project files; also scopes the / commands. */
  conversationId?: string | null
  /** App commands handled by the caller (e.g. /clear), listed in the / menu. */
  builtins?: { name: string; description: string }[]
}

type Suggestion =
  | { kind: 'command'; name: string; description: string; hint?: string; type: string }
  | { kind: 'file'; path: string }

/** What the text before the caret is asking to complete. */
function triggerAt(text: string, caret: number) {
  const before = text.slice(0, caret)
  const slash = /^\/([\w:.-]*)$/.exec(before)
  if (slash) return { kind: 'command' as const, query: slash[1]!, start: 0 }
  const at = /(^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: 'file' as const, query: at[2]!, start: caret - at[2]!.length - 1 }
  return null
}

export function Composer({
  running,
  onSend,
  onStop,
  placeholder,
  autoFocus,
  toolbar,
  conversationId,
  builtins,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState(0)
  const [commands, setCommands] = useState<CommandDTO[] | null>(null)
  const [files, setFiles] = useState<string[]>([])
  // The highlighted suggestion, remembered for the trigger it was picked in.
  const [picked, setPicked] = useState<{ key: string | null; index: number }>({
    key: null,
    index: 0,
  })
  const [dismissed, setDismissed] = useState<string | null>(null)

  const trigger = triggerAt(text, caret)
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : null

  // Commands are reloaded each time the menu opens, so new SKILL.md files show up.
  const wantsCommands = trigger?.kind === 'command'
  useEffect(() => {
    if (!wantsCommands) return
    let live = true
    void invoke('chat.commands', conversationId ?? null)
      .then((list) => live && setCommands(list))
      .catch(() => live && setCommands([]))
    return () => {
      live = false
    }
  }, [wantsCommands, conversationId])

  const fileQuery = trigger?.kind === 'file' && conversationId ? trigger.query : null
  useEffect(() => {
    if (fileQuery === null || !conversationId) return
    let live = true
    const t = setTimeout(() => {
      void invoke('chat.files', { conversationId, query: fileQuery })
        .then((list) => live && setFiles(list))
        .catch(() => live && setFiles([]))
    }, 80)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [fileQuery, conversationId])

  const suggestions: Suggestion[] =
    !trigger || triggerKey === dismissed
      ? []
      : trigger.kind === 'command'
        ? [
            ...(builtins ?? []).map((b) => ({ ...b, type: '应用' })),
            ...(commands ?? []).map((c) => ({
              name: c.name,
              description: c.description,
              hint: c.argumentHint,
              type: `${c.kind === 'skill' ? '技能' : '命令'} · ${c.scope === 'project' ? '项目' : '用户'}`,
            })),
          ]
            .filter((c) => c.name.toLowerCase().includes(trigger.query.toLowerCase()))
            .sort(
              (a, b) =>
                Number(!a.name.startsWith(trigger.query)) -
                Number(!b.name.startsWith(trigger.query)),
            )
            .slice(0, 50)
            .map((c) => ({ kind: 'command' as const, ...c }))
        : conversationId
          ? files.map((path) => ({ kind: 'file' as const, path }))
          : []
  const active =
    picked.key === triggerKey ? Math.min(picked.index, Math.max(0, suggestions.length - 1)) : 0
  const setSelected = (index: number) => setPicked({ key: triggerKey, index })

  const choose = (s: Suggestion) => {
    if (!trigger) return
    const insert =
      s.kind === 'command' ? `/${s.name} ` : `@${s.path}${s.path.endsWith('/') ? '' : ' '}`
    const next = text.slice(0, trigger.start) + insert + text.slice(caret)
    const pos = trigger.start + insert.length
    setText(next)
    setCaret(pos)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  // Auto-grow up to a cap, then scroll.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`
    el.style.overflowY = el.scrollHeight > 280 ? 'auto' : 'hidden'
  }, [text])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    setUploading((n) => n + files.length)
    for (const file of files) {
      const att = await attempt(async () =>
        invoke('blobs.put', {
          data: await readFileAsBytes(file),
          mime: guessMime(file),
          name: file.name || 'pasted.png',
        }),
      )
      if (att)
        setAttachments((list) => (list.some((a) => a.blob === att.blob) ? list : [...list, att]))
      setUploading((n) => n - 1)
    }
  }

  const canSend = !running && uploading === 0 && (text.trim().length > 0 || attachments.length > 0)

  const submit = async () => {
    if (!canSend) return
    const ok = await onSend(text, attachments)
    if (ok) {
      setText('')
      setAttachments([])
    }
  }

  return (
    <div
      className={clsx(
        'relative rounded-2xl border bg-surface shadow-[0_1px_8px_rgba(0,0,0,0.04)] transition-colors',
        dragging ? 'border-accent' : 'border-line focus-within:border-line-strong',
      )}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void addFiles([...e.dataTransfer.files])
      }}
    >
      {suggestions.length > 0 && (
        <div
          role="listbox"
          className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.kind === 'command' ? `c:${s.name}` : `f:${s.path}`}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSelected(i)}
              onClick={() => choose(s)}
              ref={(el) => {
                if (i === active) el?.scrollIntoView({ block: 'nearest' })
              }}
              className={clsx(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
                i === active ? 'bg-muted' : 'hover:bg-muted/60',
              )}
            >
              {s.kind === 'command' ? (
                <>
                  {s.type.startsWith('技能') ? (
                    <Sparkles className="size-3.5 shrink-0 text-fg-faint" />
                  ) : (
                    <Terminal className="size-3.5 shrink-0 text-fg-faint" />
                  )}
                  <span className="shrink-0 font-medium">/{s.name}</span>
                  {s.hint && <span className="shrink-0 text-fg-faint">{s.hint}</span>}
                  <span className="min-w-0 flex-1 truncate text-fg-soft">{s.description}</span>
                  <span className="shrink-0 text-[11px] text-fg-faint">{s.type}</span>
                </>
              ) : (
                <>
                  {s.path.endsWith('/') ? (
                    <Folder className="size-3.5 shrink-0 text-fg-faint" />
                  ) : (
                    <FileText className="size-3.5 shrink-0 text-fg-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{s.path}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {(attachments.length > 0 || uploading > 0) && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.blob}
              attachment={a}
              onRemove={() => setAttachments((list) => list.filter((x) => x.blob !== a.blob))}
            />
          ))}
          {uploading > 0 && (
            <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-line">
              <Spinner />
            </div>
          )}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder ?? '输入消息，Enter 发送，Shift+Enter 换行'}
        onChange={(e) => {
          setText(e.target.value)
          setCaret(e.target.selectionStart)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setDismissed(triggerKey)}
        onFocus={() => setDismissed(null)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.length) {
            e.preventDefault()
            void addFiles(files)
          }
        }}
        onKeyDown={(e) => {
          if (suggestions.length && !e.nativeEvent.isComposing) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const d = e.key === 'ArrowDown' ? 1 : -1
              setSelected((active + d + suggestions.length) % suggestions.length)
              return
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
              const s = suggestions[active]!
              // Enter on an exact command runs it rather than re-inserting it.
              const exact = s.kind === 'command' && trigger?.query === s.name && e.key === 'Enter'
              if (!exact) {
                e.preventDefault()
                choose(s)
                return
              }
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setDismissed(triggerKey)
              return
            }
          }
          // Don't send while an IME (e.g. pinyin) is composing.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        className="block max-h-[280px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-relaxed outline-none placeholder:text-fg-faint"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <IconButton label="添加附件（图片、PDF、文本）" onClick={() => fileRef.current?.click()}>
          <Paperclip className="size-4" />
        </IconButton>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <div className="flex min-w-0 flex-1 items-center gap-1 whitespace-nowrap">{toolbar}</div>
        {running ? (
          <button
            type="button"
            onClick={onStop}
            title="停止生成"
            className="flex size-8 items-center justify-center rounded-full bg-fg text-surface hover:opacity-85"
          >
            <Square className="size-3 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            title="发送"
            className="flex size-8 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:bg-accent-strong disabled:opacity-30"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}

export function AttachmentChip({
  attachment: a,
  onRemove,
}: {
  attachment: Attachment
  onRemove?: () => void
}) {
  const isImage = a.mime.startsWith('image/')
  return (
    <div className="group relative">
      {isImage ? (
        <img
          src={blobUrl(a.blob)}
          alt={a.name}
          className="h-14 w-14 rounded-lg border border-line object-cover"
        />
      ) : (
        <div className="flex h-14 max-w-48 items-center gap-2 rounded-lg border border-line bg-muted/50 px-3">
          <FileText className="size-5 shrink-0 text-fg-faint" />
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{a.name}</div>
            <div className="truncate text-[11px] text-fg-faint">{a.mime}</div>
          </div>
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label="移除"
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 hidden size-5 items-center justify-center rounded-full bg-fg text-surface group-hover:flex"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}
