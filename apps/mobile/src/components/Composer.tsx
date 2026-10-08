import { ArrowUp, ImagePlus, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export interface ImageDraft {
  name: string
  mime: string
  /** base64 without data: prefix */
  data: string
  preview: string
}

const MAX_IMAGE = 6 * 1024 * 1024

async function toDraft(file: File): Promise<ImageDraft> {
  if (file.size > MAX_IMAGE) throw new Error('图片过大（上限 6MB）')
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
  return {
    name: file.name || 'photo.jpg',
    mime: file.type || 'image/jpeg',
    data: url.split(',')[1] ?? '',
    preview: url,
  }
}

export function Composer({
  placeholder,
  running,
  disabled,
  allowImages = true,
  onSend,
  onStop,
}: {
  placeholder: string
  running: boolean
  disabled?: boolean
  allowImages?: boolean
  onSend: (text: string, images: ImageDraft[]) => Promise<boolean>
  onStop?: () => void
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageDraft[]>([])
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const canSend = !running && !busy && !disabled && (text.trim() || images.length)

  const submit = async () => {
    if (!canSend) return
    setBusy(true)
    const ok = await onSend(text, images)
    setBusy(false)
    if (ok) {
      setText('')
      setImages([])
    }
  }

  return (
    <div className="safe-bottom border-t border-line bg-canvas px-3 pt-2">
      {images.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto">
          {images.map((img, i) => (
            <div key={i} className="relative shrink-0">
              <img src={img.preview} alt="" className="size-16 rounded-lg object-cover" />
              <button
                type="button"
                aria-label="移除"
                onClick={() => setImages((l) => l.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-fg text-surface"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        {allowImages && (
          <>
            <button
              type="button"
              aria-label="添加图片"
              onClick={() => file.current?.click()}
              className="mb-1 flex size-9 shrink-0 items-center justify-center rounded-full text-fg-soft active:bg-muted"
            >
              <ImagePlus className="size-5" />
            </button>
            <input
              ref={file}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={async (e) => {
                const files = [...(e.target.files ?? [])]
                e.target.value = ''
                for (const f of files) {
                  try {
                    const d = await toDraft(f)
                    setImages((l) => [...l, d])
                  } catch (err) {
                    alert((err as Error).message)
                  }
                }
              }}
            />
          </>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          enterKeyHint="send"
          onKeyDown={(e) => {
            // On phones Enter inserts a newline; a hardware keyboard can send with ⌘/Ctrl+Enter.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
          className="max-h-40 min-h-11 flex-1 resize-none rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-[16px] leading-snug outline-none focus:border-line-strong"
        />
        {running ? (
          <button
            type="button"
            aria-label="停止"
            onClick={onStop}
            className="mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-fg text-surface active:opacity-70"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="发送"
            disabled={!canSend}
            onClick={() => void submit()}
            className="mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-30 active:opacity-70"
          >
            <ArrowUp className="size-5" />
          </button>
        )}
      </div>
    </div>
  )
}
