import { FolderOpen, Plus, Sparkles, SquareSlash, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CommandDTO, SkillRootDTO } from '../../../shared/ipc'
import { invoke } from '../lib/api'
import { attempt, succeeded, useApp } from '../store/app'
import { Badge, Button, Field, Input, Modal, Select, Spinner, Textarea } from './ui'

const KIND_LABEL = { skill: '技能', command: '命令' } as const

export function SkillsTab() {
  const projects = useApp((s) => s.projects)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [roots, setRoots] = useState<SkillRootDTO[]>([])
  const [items, setItems] = useState<CommandDTO[] | null>(null)
  const [editing, setEditing] = useState<CommandDTO | null>(null)
  const [creating, setCreating] = useState(false)

  const reload = () =>
    void attempt(() => invoke('skills.list', projectId)).then((r) => {
      if (!r) return
      setRoots(r.roots)
      setItems(r.items)
    })
  useEffect(reload, [projectId])

  /** The folder an item lives in, e.g. "~/.claude" or "项目/.aitech". */
  const source = (item: CommandDTO) => {
    const root = roots.find((r) => item.path.startsWith(r.dir))
    const folder = root?.dir.split(/[\\/]/).pop() ?? ''
    return `${item.scope === 'project' ? '项目' : '用户'} ${folder}`
  }

  return (
    <div className="max-w-2xl space-y-5 p-6">
      <section>
        <div className="flex items-center">
          <h2 className="text-base font-semibold">技能与命令</h2>
          <Button className="ml-auto" variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            新建
          </Button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          技能是 AI 在需要时自动读取的操作说明；命令是在输入框里用 /名称 调用的提示词模板。 兼容
          Claude Code 的 skills 和 commands 文件夹。
        </p>
      </section>

      <Field label="查看范围" hint="项目里的同名技能或命令会覆盖用户的">
        <Select value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
          <option value="">我的（所有对话可用）</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              项目：{p.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="overflow-hidden rounded-xl border border-line">
        {items === null ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          items.map((item) => (
            <button
              key={item.path}
              type="button"
              onClick={() => setEditing(item)}
              className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-muted/50"
            >
              {item.kind === 'skill' ? (
                <Sparkles className="size-4 shrink-0 text-fg-faint" />
              ) : (
                <SquareSlash className="size-4 shrink-0 text-fg-faint" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {item.kind === 'command' ? `/${item.name}` : item.name}
                  </span>
                  {item.shadowed && <Badge tone="warn">已被覆盖</Badge>}
                </div>
                <div className="truncate text-xs text-fg-faint">
                  {item.description || '（没有描述）'}
                </div>
              </div>
              <Badge>{KIND_LABEL[item.kind]}</Badge>
              <span className="w-24 shrink-0 truncate text-right font-mono text-[11px] text-fg-faint">
                {source(item)}
              </span>
            </button>
          ))
        )}
        {items?.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-fg-faint">还没有技能或命令</div>
        )}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="新建技能或命令">
        {creating && (
          <CreateForm
            projectId={projectId}
            scopeLabel={projectId ? '这个项目' : '我的（所有对话可用）'}
            onCreated={(path, kind, name) => {
              setCreating(false)
              reload()
              setEditing({
                kind,
                name,
                description: '',
                path,
                scope: projectId ? 'project' : 'user',
              })
            }}
          />
        )}
      </Modal>

      <Modal
        wide
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing
            ? `编辑${KIND_LABEL[editing.kind]}「${editing.kind === 'command' ? '/' : ''}${editing.name}」`
            : undefined
        }
      >
        {editing && (
          <Editor
            key={editing.path}
            item={editing}
            onDone={() => {
              setEditing(null)
              reload()
            }}
          />
        )}
      </Modal>
    </div>
  )
}

function CreateForm({
  projectId,
  scopeLabel,
  onCreated,
}: {
  projectId: string | null
  scopeLabel: string
  onCreated: (path: string, kind: CommandDTO['kind'], name: string) => void
}) {
  const [kind, setKind] = useState<CommandDTO['kind']>('skill')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  const create = async () => {
    setSaving(true)
    const path = await attempt(() =>
      invoke('skills.create', { projectId, kind, name: name.trim(), description }),
    )
    setSaving(false)
    if (path) onCreated(path, kind, name.trim())
  }

  return (
    <>
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-[9rem_1fr] gap-3">
          <Field label="类型">
            <Select value={kind} onChange={(e) => setKind(e.target.value as CommandDTO['kind'])}>
              <option value="skill">技能</option>
              <option value="command">命令</option>
            </Select>
          </Field>
          <Field label="名称">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'skill' ? 'weekly-report' : 'review'}
            />
          </Field>
        </div>
        <Field
          label="描述"
          hint={
            kind === 'skill'
              ? 'AI 根据描述判断什么时候用这个技能，写清楚它做什么、什么情况下用'
              : '显示在 / 菜单里'
          }
        >
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <p className="text-xs text-fg-faint">保存位置：{scopeLabel}的 .aitech 文件夹</p>
      </div>
      <div className="flex justify-end border-t border-line px-5 py-3">
        <Button
          variant="primary"
          loading={saving}
          disabled={!name.trim()}
          onClick={() => void create()}
        >
          创建并编辑
        </Button>
      </div>
    </>
  )
}

function Editor({ item, onDone }: { item: CommandDTO; onDone: () => void }) {
  const [content, setContent] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void attempt(() => invoke('skills.read', item.path)).then((text) => {
      if (text === undefined) return
      setContent(text)
      setSaved(text)
    })
  }, [item.path])

  const save = async () => {
    if (content === null) return
    setSaving(true)
    const ok = await succeeded(() => invoke('skills.save', { path: item.path, content }))
    setSaving(false)
    if (ok) onDone()
  }

  return (
    <>
      <div className="space-y-2 p-5">
        <div className="truncate font-mono text-xs text-fg-faint" title={item.path}>
          {item.path}
        </div>
        {content === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <Textarea
            className="h-[55vh] resize-none font-mono text-xs leading-relaxed"
            spellCheck={false}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault()
                void save()
              }
            }}
          />
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-5 py-3">
        <Button
          variant="ghost"
          className="text-red-600 dark:text-red-400"
          onClick={async () => {
            if (
              window.confirm(
                `把${KIND_LABEL[item.kind]}「${item.name}」移到废纸篓？${item.kind === 'skill' ? '整个技能文件夹都会移走。' : ''}`,
              ) &&
              (await succeeded(() => invoke('skills.delete', item.path)))
            )
              onDone()
          }}
        >
          <Trash2 className="size-4" />
          删除
        </Button>
        <Button
          variant="ghost"
          onClick={() => void succeeded(() => invoke('skills.reveal', item.path))}
        >
          <FolderOpen className="size-4" />
          打开所在文件夹
        </Button>
        <Button
          className="ml-auto"
          variant="primary"
          loading={saving}
          disabled={content === null || content === saved}
          onClick={() => void save()}
        >
          保存
        </Button>
      </div>
    </>
  )
}
