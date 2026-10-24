import clsx from 'clsx'
import {
  ChevronRight,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ConversationDTO, ProjectDTO } from '../../../shared/ipc'
import { invoke, isMac } from '../lib/api'
import { dayGroup } from '../lib/format'
import { attempt, succeeded, useApp } from '../store/app'
import { useChat } from '../store/chat'
import { Button, Field, Input, Modal, Select, Textarea, useDismiss } from './ui'

export function Sidebar({
  onNewChat,
  onNewTask,
  onNewProject,
}: {
  onNewChat: () => void
  onNewTask: (projectId: string) => void
  onNewProject: () => void
}) {
  const {
    conversations,
    activeId,
    view,
    mode,
    setMode,
    search,
    setSearch,
    open,
    setView,
    running,
    projects,
  } = useApp()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const activeProjectId = conversations.find((c) => c.id === activeId)?.projectId ?? null
  const byProject = useMemo(() => {
    const map = new Map<string, ConversationDTO[]>()
    for (const c of conversations) {
      if (!c.projectId) continue
      map.set(c.projectId, [...(map.get(c.projectId) ?? []), c])
    }
    return map
  }, [conversations])

  const groups = useMemo(() => {
    const out: { label: string; items: ConversationDTO[] }[] = []
    for (const c of conversations) {
      if (c.projectId) continue
      const label = c.pinned ? '置顶' : dayGroup(c.updatedAt)
      const last = out.at(-1)
      if (last?.label === label) last.items.push(c)
      else out.push({ label, items: [c] })
    }
    return out
  }, [conversations])

  const newInMode = () => {
    if (mode === 'chat') return onNewChat()
    const projectId = activeProjectId ?? projects[0]?.id
    if (projectId) onNewTask(projectId)
    else onNewProject()
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-canvas">
      <div className="drag h-12 shrink-0" />

      <div className="px-3 pb-2">
        <div className="flex rounded-lg bg-muted/70 p-0.5 text-sm">
          {(
            [
              ['chat', '对话', <MessagesSquare key="i" className="size-3.5" />],
              ['code', 'Code', <Code2 key="i" className="size-3.5" />],
            ] as const
          ).map(([m, label, icon]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={clsx(
                'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md transition-colors',
                mode === m
                  ? 'bg-surface font-medium text-fg shadow-sm'
                  : 'text-fg-faint hover:text-fg',
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-2 pb-1.5">
        <button
          type="button"
          onClick={newInMode}
          className="group flex h-9 w-full items-center gap-2.5 rounded-lg px-1.5 text-sm font-medium text-fg transition-colors hover:bg-muted/70"
        >
          <span className="flex size-6 items-center justify-center rounded-full bg-accent text-white transition-transform group-hover:scale-105">
            <Plus className="size-3.5" strokeWidth={2.5} />
          </span>
          <span className="flex-1 text-left">{mode === 'chat' ? '新对话' : '新任务'}</span>
          {mode === 'chat' && (
            <kbd className="font-sans text-[11px] text-fg-faint opacity-0 transition-opacity group-hover:opacity-100">
              {isMac ? '⌘N' : 'Ctrl+N'}
            </kbd>
          )}
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={mode === 'chat' ? '搜索对话' : '搜索任务'}
            className="h-8 w-full rounded-lg border border-transparent bg-muted/70 pr-2 pl-8 text-sm outline-none placeholder:text-fg-faint focus:border-line-strong focus:bg-surface"
          />
        </div>
      </div>

      {mode === 'chat' && (
        <nav className="space-y-0.5 px-2 pb-2">
          <NavItem
            active={view === 'images'}
            onClick={() => setView('images')}
            icon={<Image className="size-4" />}
          >
            生图 / 视频
          </NavItem>
        </nav>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {mode === 'code' ? (
          <div className="mb-2">
            <div className="group flex items-center px-2 pt-2 pb-1">
              <span className="flex-1 text-[11px] font-medium text-fg-faint">项目</span>
              <button
                type="button"
                title="添加项目文件夹"
                onClick={onNewProject}
                className="rounded p-0.5 text-fg-faint hover:bg-line hover:text-fg"
              >
                <FolderPlus className="size-3.5" />
              </button>
            </div>
            {projects.map((p) => (
              <ProjectItem
                key={p.id}
                project={p}
                open={expanded.has(p.id) || p.id === activeProjectId || !!search}
                onToggle={() =>
                  setExpanded((s) => {
                    const next = new Set(s)
                    if (next.has(p.id)) next.delete(p.id)
                    else next.add(p.id)
                    return next
                  })
                }
                onNewTask={() => onNewTask(p.id)}
              >
                {(byProject.get(p.id) ?? []).map((c) => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    active={view === 'chat' && c.id === activeId}
                    running={running.has(c.id)}
                    onOpen={() => open(c.id)}
                  />
                ))}
              </ProjectItem>
            ))}
            {!projects.length && (
              <button
                type="button"
                onClick={onNewProject}
                className="mx-1 w-[calc(100%-0.5rem)] rounded-lg border border-dashed border-line-strong px-3 py-2 text-left text-xs text-fg-faint hover:border-accent hover:text-accent"
              >
                添加一个项目文件夹，让 AI 帮你写代码
              </button>
            )}
          </div>
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.label} className="mb-2">
                <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-fg-faint">
                  {g.label}
                </div>
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
            {!groups.length && (
              <div className="px-3 py-6 text-center text-xs text-fg-faint">
                {search ? '没有匹配的对话' : '还没有对话'}
              </div>
            )}
          </>
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

function ProjectItem({
  project,
  open,
  onToggle,
  onNewTask,
  children,
}: {
  project: ProjectDTO
  open: boolean
  onToggle: () => void
  onNewTask: () => void
  children: React.ReactNode
}) {
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const ref = useDismiss(menu, () => setMenu(false))
  return (
    <div>
      <div ref={ref} className="group relative">
        <button
          type="button"
          onClick={onToggle}
          title={project.rootPath}
          className="flex h-8 w-full items-center gap-1.5 rounded-lg pr-14 pl-1.5 text-left text-sm text-fg-soft hover:bg-muted/70 hover:text-fg"
        >
          <ChevronRight
            className={clsx(
              'size-3.5 shrink-0 text-fg-faint transition-transform',
              open && 'rotate-90',
            )}
          />
          <Folder className="size-4 shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>
        <div
          className={clsx(
            'absolute top-1 right-1 flex',
            menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <button
            type="button"
            title="项目设置"
            onClick={() => setMenu((v) => !v)}
            className="rounded-md p-1 text-fg-faint hover:bg-line hover:text-fg"
          >
            <MoreHorizontal className="size-4" />
          </button>
          <button
            type="button"
            title="新任务"
            onClick={onNewTask}
            className="rounded-md p-1 text-fg-faint hover:bg-line hover:text-fg"
          >
            <Plus className="size-4" />
          </button>
        </div>
        {menu && (
          <div className="absolute top-8 right-1 z-20 w-40 overflow-hidden rounded-xl border border-line bg-surface py-1 text-sm shadow-lg">
            <MenuItem
              icon={<Settings className="size-3.5" />}
              onClick={() => {
                setMenu(false)
                setEditing(true)
              }}
            >
              项目设置
            </MenuItem>
            <MenuItem
              icon={<FolderOpen className="size-3.5" />}
              onClick={() => {
                setMenu(false)
                void attempt(() => invoke('projects.reveal', project.id))
              }}
            >
              打开文件夹
            </MenuItem>
            <MenuItem
              danger
              icon={<Trash2 className="size-3.5" />}
              onClick={async () => {
                setMenu(false)
                if (
                  !window.confirm(
                    `从应用中移除项目「${project.name}」及其对话？\n文件夹里的文件不会被删除。`,
                  )
                )
                  return
                await succeeded(() => invoke('projects.delete', project.id))
              }}
            >
              移除项目
            </MenuItem>
          </div>
        )}
      </div>
      {open && <div className="ml-4 border-l border-line pl-1">{children}</div>}
      <Modal open={editing} onClose={() => setEditing(false)} title="项目设置">
        {editing && <ProjectSettings project={project} onClose={() => setEditing(false)} />}
      </Modal>
    </div>
  )
}

function ProjectSettings({ project, onClose }: { project: ProjectDTO; onClose: () => void }) {
  const { models, upsertProject } = useApp()
  const [name, setName] = useState(project.name)
  const [instructions, setInstructions] = useState(project.instructions ?? '')
  const [modelId, setModelId] = useState(project.defaultModelId ?? '')
  const chatModels = models.filter((m) => m.capabilities.includes('chat'))

  return (
    <>
      <div className="space-y-4 p-5">
        <Field label="名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="文件夹">
          <div
            className="truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs text-fg-soft"
            title={project.rootPath}
          >
            {project.rootPath}
          </div>
        </Field>
        <Field label="默认模型">
          <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            <option value="">使用全局默认</option>
            {chatModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName || m.modelId}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="项目说明"
          hint="每个任务都会带上这些说明。项目根目录下的 AGENTS.md / CLAUDE.md 也会自动读取。"
        >
          <Textarea
            rows={6}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="例如：使用 pnpm；提交前运行 pnpm test；代码注释用英文。"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          variant="primary"
          disabled={!name.trim()}
          onClick={async () => {
            const next = await attempt(() =>
              invoke('projects.update', project.id, {
                name: name.trim(),
                instructions: instructions.trim() || null,
                defaultModelId: modelId || null,
              }),
            )
            if (next) {
              upsertProject(next)
              onClose()
            }
          }}
        >
          保存
        </Button>
      </div>
    </>
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
