import clsx from 'clsx'
import {
  Image,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  PinOff,
  Search,
  Settings,
  Trash2,
  Pencil,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ConversationDTO } from '../../../shared/ipc'
import { invoke, isMac } from '../lib/api'
import { dayGroup } from '../lib/format'
import { attempt, succeeded, useApp } from '../store/app'
import { useChat } from '../store/chat'
import { IconButton, useDismiss } from './ui'

export function Sidebar({ onNewChat }: { onNewChat: () => void }) {
  const { conversations, activeId, view, search, setSearch, open, setView, running } = useApp()

  const groups = useMemo(() => {
    const out: { label: string; items: ConversationDTO[] }[] = []
    for (const c of conversations) {
      const label = c.pinned ? '置顶' : dayGroup(c.updatedAt)
      const last = out.at(-1)
      if (last?.label === label) last.items.push(c)
      else out.push({ label, items: [c] })
    }
    return out
  }, [conversations])

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-canvas">
      <div
        className={clsx(
          'drag flex h-12 shrink-0 items-center justify-end gap-1 px-2',
          isMac && 'pl-20',
        )}
      >
        <IconButton label="新对话 (⌘N)" onClick={onNewChat}>
          <MessageSquarePlus className="size-4.5" />
        </IconButton>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索对话"
            className="h-8 w-full rounded-lg border border-transparent bg-muted/70 pr-2 pl-8 text-sm outline-none placeholder:text-fg-faint focus:border-line-strong focus:bg-surface"
          />
        </div>
      </div>

      <nav className="space-y-0.5 px-2 pb-2">
        <NavItem
          active={view === 'images'}
          onClick={() => setView('images')}
          icon={<Image className="size-4" />}
        >
          生图
        </NavItem>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map((g) => (
          <div key={g.label} className="mb-2">
            <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-fg-faint">{g.label}</div>
            {g.items.map((c) => (
              <ConversationItem
                key={c.id}
                conversation={c}
                active={view === 'chat' && c.id === activeId}
                running={running.has(c.id)}
                onOpen={() => open(c.id)}
              />
            ))}
          </div>
        ))}
        {!conversations.length && (
          <div className="px-3 py-6 text-center text-xs text-fg-faint">
            {search ? '没有匹配的对话' : '还没有对话'}
          </div>
        )}
      </div>

      <div className="border-t border-line p-2">
        <NavItem
          active={view === 'settings'}
          onClick={() => setView('settings')}
          icon={<Settings className="size-4" />}
        >
          设置
        </NavItem>
      </div>
    </aside>
  )
}

function NavItem({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
        active ? 'bg-muted font-medium text-fg' : 'text-fg-soft hover:bg-muted/70 hover:text-fg',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function ConversationItem({
  conversation: c,
  active,
  running,
  onOpen,
}: {
  conversation: ConversationDTO
  active: boolean
  running: boolean
  onOpen: () => void
}) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(c.title ?? '')
  const ref = useDismiss(menu, () => setMenu(false))
  const { removeConversation } = useApp()
  const { setConversation } = useChat()

  const update = async (patch: { title?: string | null; pinned?: boolean }) => {
    const next = await attempt(() => invoke('conversations.update', c.id, patch))
    if (next) setConversation(next)
  }

  if (renaming) {
    return (
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          setRenaming(false)
          if (title.trim() && title !== c.title) void update({ title: title.trim() })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setTitle(c.title ?? '')
            setRenaming(false)
          }
        }}
        className="h-8 w-full rounded-lg border border-accent bg-surface px-2.5 text-sm outline-none"
      />
    )
  }

  return (
    <div ref={ref} className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className={clsx(
          'flex h-8 w-full items-center gap-2 rounded-lg pr-8 pl-2.5 text-left text-sm transition-colors',
          active ? 'bg-muted text-fg' : 'text-fg-soft hover:bg-muted/70 hover:text-fg',
        )}
      >
        {running && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
        <span className="truncate">{c.title || '新对话'}</span>
      </button>
      <button
        type="button"
        aria-label="更多"
        onClick={() => setMenu((v) => !v)}
        className={clsx(
          'absolute top-1 right-1 rounded-md p-1 text-fg-faint hover:bg-line hover:text-fg',
          menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {menu && (
        <div className="absolute top-8 right-1 z-20 w-36 overflow-hidden rounded-xl border border-line bg-surface py-1 text-sm shadow-lg">
          <MenuItem
            icon={<Pencil className="size-3.5" />}
            onClick={() => {
              setMenu(false)
              setTitle(c.title ?? '')
              setRenaming(true)
            }}
          >
            重命名
          </MenuItem>
          <MenuItem
            icon={c.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            onClick={() => {
              setMenu(false)
              void update({ pinned: !c.pinned })
            }}
          >
            {c.pinned ? '取消置顶' : '置顶'}
          </MenuItem>
          <MenuItem
            danger
            icon={<Trash2 className="size-3.5" />}
            onClick={async () => {
              setMenu(false)
              if (!window.confirm(`删除对话「${c.title || '新对话'}」？`)) return
              const ok = await succeeded(() => invoke('conversations.delete', c.id))
              if (ok) removeConversation(c.id)
            }}
          >
            删除
          </MenuItem>
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  icon,
  danger,
  onClick,
  children,
}: {
  icon?: React.ReactNode
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted',
        danger ? 'text-red-600 dark:text-red-400' : 'text-fg',
      )}
    >
      {icon}
      {children}
    </button>
  )
}
