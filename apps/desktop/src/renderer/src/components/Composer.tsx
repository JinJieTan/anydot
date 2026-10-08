import clsx from 'clsx'
import { ArrowUp, FileText, Paperclip, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Attachment } from '../../../shared/ipc'
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
}

export function Composer({
  running,
  onSend,
  onStop,
  placeholder,
  autoFocus,
  toolbar,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
        'rounded-2xl border bg-surface shadow-[0_1px_8px_rgba(0,0,0,0.04)] transition-colors',
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
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.length) {
            e.preventDefault()
            void addFiles(files)
          }
        }}
        onKeyDown={(e) => {
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
        <div className="flex min-w-0 flex-1 items-center gap-1">{toolbar}</div>
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
