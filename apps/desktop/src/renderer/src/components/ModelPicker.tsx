import clsx from 'clsx'
import { Check, ChevronDown, Brain } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ThinkingLevel } from '@aitech/core'
import type { Capability } from '@aitech/core'
import type { ModelDTO } from '../../../shared/ipc'
import { useApp } from '../store/app'
import { useDismiss } from './ui'

export function modelLabel(m: ModelDTO | undefined | null): string {
  if (!m) return '选择模型'
  return m.displayName || m.modelId
}

export function ModelPicker({
  value,
  onChange,
  capability = 'chat',
  align = 'left',
  direction = 'up',
}: {
  value: string | null
  onChange: (id: string) => void
  capability?: Capability
  align?: 'left' | 'right'
  direction?: 'up' | 'down'
}) {
  const { models, providers } = useApp()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useDismiss(open, () => setOpen(false))

  const usable = useMemo(
    () => models.filter((m) => m.capabilities.includes(capability)),
    [models, capability],
  )
  const current = usable.find((m) => m.id === value)

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase()
    return providers
      .map((p) => ({
        provider: p,
        items: usable.filter(
          (m) =>
            m.providerId === p.id &&
            (!query ||
              m.modelId.toLowerCase().includes(query) ||
              m.displayName?.toLowerCase().includes(query)),
        ),
      }))
      .filter((g) => g.items.length)
  }, [providers, usable, q])

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 max-w-64 min-w-0 items-center gap-1 rounded-lg px-2 text-sm text-fg-soft hover:bg-muted hover:text-fg"
      >
        <span className="truncate">
          {current ? modelLabel(current) : usable.length ? '选择模型' : '暂无可用模型'}
        </span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>
      {open && (
        <div
          className={clsx(
            'absolute z-30 w-72 overflow-hidden rounded-xl border border-line bg-surface shadow-xl',
            direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {usable.length > 8 && (
            <div className="border-b border-line p-2">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索模型"
                className="h-8 w-full rounded-lg bg-muted px-2.5 text-sm outline-none"
              />
            </div>
          )}
          <div className="max-h-80 overflow-y-auto py-1">
            {groups.map((g) => (
              <div key={g.provider.id}>
                {providers.length > 1 && (
                  <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-fg-faint">
                    {g.provider.name}
                  </div>
                )}
                {g.items.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onChange(m.id)
                      setOpen(false)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <span className="min-w-0 flex-1 truncate">{modelLabel(m)}</span>
                    {m.capabilities.includes('reasoning') && (
                      <Brain className="size-3.5 text-fg-faint" />
                    )}
                    {m.id === value && <Check className="size-3.5 text-accent" />}
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && (
              <div className="px-3 py-4 text-center text-xs text-fg-faint">没有匹配的模型</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

export function ThinkingPicker({
  value,
  onChange,
}: {
  value: ThinkingLevel
  onChange: (v: ThinkingLevel) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="深度思考"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'flex h-8 items-center gap-1 rounded-lg px-2 text-sm hover:bg-muted',
          value === 'off' ? 'text-fg-soft' : 'text-accent',
        )}
      >
        <Brain className="size-4" />
        <span>
          {value === 'off' ? '思考' : `思考·${LEVELS.find((l) => l.value === value)?.label}`}
        </span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-32 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              onClick={() => {
                onChange(l.value)
                setOpen(false)
              }}
              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted"
            >
              {l.label}
              {l.value === value && <Check className="size-3.5 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
