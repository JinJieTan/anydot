import clsx from 'clsx'
import { Folder, FolderOpen, Settings2, Sparkles, Terminal } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  Attachment,
  ConversationDTO,
  PermissionMode,
  ProjectDTO,
  Rpc,
} from '../../../shared/ipc'
import { Composer } from '../components/Composer'
import { AssistantMessage, UserMessage } from '../components/Message'
import { ModelPicker, ThinkingPicker } from '../components/ModelPicker'
import type { ToolResultPart } from '../components/ToolCall'
import { Button, Field, IconButton, Input, Modal, Textarea, useDismiss } from '../components/ui'
import { invoke, isMac } from '../lib/api'
import { activePath, siblingsOf } from '../lib/tree'
import { attempt, succeeded, useApp } from '../store/app'
import { useChat } from '../store/chat'

export function ChatView() {
  const { activeId, running, models, providers, settings, setView, open, projects } = useApp()
  const conversation = useChat((s) => (activeId ? s.conversations[activeId] : undefined))
  const messages = useChat((s) => (activeId ? s.messages[activeId] : undefined))
  const { load, setConversation } = useChat()
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    if (activeId && !messages) void load(activeId)
  }, [activeId, messages, load])

  const path = useMemo(
    () => (messages && conversation ? activePath(messages, conversation.activeLeafId) : []),
    [messages, conversation],
  )

  const project = conversation?.projectId
    ? projects.find((p) => p.id === conversation.projectId)
    : undefined
  const isRunning = !!activeId && running.has(activeId)
  const chatModels = models.filter((m) => m.capabilities.includes('chat'))

  // Model shown in the picker before a conversation exists.
  const [draftModelId, setDraftModelId] = useState<string | null>(null)
  const draftThinking = settings.defaultThinking
  const effectiveModelId =
    conversation?.modelId ?? draftModelId ?? settings.defaultModelId ?? chatModels[0]?.id ?? null
  const model = models.find((m) => m.id === effectiveModelId)

  const update = useCallback(
    async (patch: Parameters<Rpc['conversations.update']>[1]) => {
      if (!conversation) return
      const next = await attempt(() => invoke('conversations.update', conversation.id, patch))
      if (next) setConversation(next)
    },
    [conversation, setConversation],
  )

  const send = async (text: string, attachments: Attachment[]): Promise<boolean> => {
    let conv: ConversationDTO | undefined = conversation
    if (!conv) {
      conv = await attempt(() => invoke('conversations.create', { modelId: effectiveModelId }))
      if (!conv) return false
      setConversation(conv)
      useChat.setState((s) => ({ messages: { ...s.messages, [conv!.id]: [] } }))
      open(conv.id)
    }
    const id = conv.id
    return succeeded(() => invoke('chat.send', { conversationId: id, text, attachments }))
  }

  const toolbar = (
    <>
      <ModelPicker
        value={effectiveModelId}
        onChange={(id) => (conversation ? void update({ modelId: id }) : setDraftModelId(id))}
      />
      {model?.capabilities.includes('reasoning') && (
        <ThinkingPicker
          value={conversation?.thinking ?? draftThinking}
          onChange={(thinking) =>
            conversation
              ? void update({ thinking })
              : void useApp.getState().updateSettings({ defaultThinking: thinking })
          }
        />
      )}
      {project && <ModePicker project={project} />}
    </>
  )

  const composer = (
    <Composer
      running={isRunning}
      autoFocus
      toolbar={toolbar}
      onSend={send}
      onStop={() => activeId && void invoke('chat.stop', activeId)}
      placeholder={project ? `让 AI 在 ${project.name} 中完成任务，Enter 发送` : undefined}
    />
  )

  // ── empty state ──
  if (!conversation || path.length === 0) {
    const noProviders = providers.length === 0
    return (
      <div className="flex h-full flex-col">
        <div className="drag h-12 shrink-0" />
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
          <div className="w-full max-w-2xl">
            <div className="mb-8 flex flex-col items-center text-center">
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/12 text-accent">
                {project ? <Terminal className="size-6" /> : <Sparkles className="size-6" />}
              </div>
              <h1 className="text-2xl font-semibold">
                {project ? `在「${project.name}」中做点什么？` : '有什么可以帮你？'}
              </h1>
              {project && (
                <p
                  className="mt-2 max-w-md truncate font-mono text-xs text-fg-faint"
                  title={project.rootPath}
                >
                  {project.rootPath}
                </p>
              )}
              {noProviders && (
                <p className="mt-2 text-sm text-fg-soft">
                  先添加一个服务商：填入 Base URL 和 API Key 就能开始。
                </p>
              )}
            </div>
            {noProviders ? (
              <div className="flex justify-center">
                <Button variant="primary" onClick={() => setView('settings')}>
                  添加服务商
                </Button>
              </div>
            ) : (
              composer
            )}
            {project && !noProviders && (
              <p className="mt-3 text-center text-xs text-fg-faint">
                AI 可以读取和修改这个文件夹中的文件、运行命令。修改前会按当前权限模式征求你的确认。
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header
        className={clsx(
          'drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-4',
          isMac && 'pl-4',
        )}
      >
        {project && (
          <button
            type="button"
            onClick={() => void attempt(() => invoke('projects.reveal', project.id))}
            title={`在文件管理器中打开 ${project.rootPath}`}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-fg-soft hover:text-fg"
          >
            <Folder className="size-3.5" />
            {project.name}
          </button>
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {conversation.title || '新对话'}
        </h1>
        {project ? (
          <IconButton
            label="打开项目文件夹"
            onClick={() => void attempt(() => invoke('projects.reveal', project.id))}
          >
            <FolderOpen className="size-4" />
          </IconButton>
        ) : (
          <IconButton
            label="打开工作文件夹"
            onClick={() =>
              void attempt(() => invoke('conversations.revealWorkspace', conversation.id))
            }
          >
            <FolderOpen className="size-4" />
          </IconButton>
        )}
        <IconButton label="对话设置" onClick={() => setShowSettings(true)}>
          <Settings2 className="size-4" />
        </IconButton>
      </header>

      <MessageList conversation={conversation} path={path} busy={isRunning} />

      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto max-w-3xl">{composer}</div>
      </div>

      <ConversationSettings
        open={showSettings}
        conversation={conversation}
        onClose={() => setShowSettings(false)}
        onSave={async (patch) => {
          await update(patch)
          setShowSettings(false)
        }}
      />
    </div>
  )
}

const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'ask', label: '每次询问', hint: '修改文件、运行命令前都先确认' },
  { value: 'auto-edit', label: '自动改文件', hint: '项目内的文件修改直接执行，命令仍需确认' },
  { value: 'auto', label: '全自动', hint: '除危险命令和项目外路径外都直接执行' },
  { value: 'plan', label: '只读规划', hint: '只阅读代码并给出方案，不做任何修改' },
]

function ModePicker({ project }: { project: ProjectDTO }) {
  const [openMenu, setOpenMenu] = useState(false)
  const ref = useDismiss(openMenu, () => setOpenMenu(false))
  const current = MODES.find((m) => m.value === project.permissionMode) ?? MODES[0]!
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="权限模式（对整个项目生效）"
        onClick={() => setOpenMenu((v) => !v)}
        className={clsx(
          'flex h-8 items-center gap-1 rounded-lg px-2 text-sm hover:bg-muted',
          project.permissionMode === 'auto' ? 'text-amber-600 dark:text-amber-400' : 'text-fg-soft',
        )}
      >
        {current.label}
      </button>
      {openMenu && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={async () => {
                setOpenMenu(false)
                const next = await attempt(() =>
                  invoke('projects.update', project.id, { permissionMode: m.value }),
                )
                if (next) useApp.getState().upsertProject(next)
              }}
              className={clsx(
                'block w-full px-3 py-2 text-left hover:bg-muted',
                m.value === project.permissionMode && 'bg-muted/60',
              )}
            >
              <div className="text-sm">{m.label}</div>
              <div className="text-xs text-fg-faint">{m.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const EMPTY = new Map<string, ToolResultPart>()

/** Where the agent compacted its context; the summary is what it continued from. */
function SummaryDivider({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 text-xs text-fg-faint hover:text-fg-soft"
      >
        <span className="h-px flex-1 bg-line" />
        上文已自动压缩为摘要{open ? '（收起）' : '（查看）'}
        <span className="h-px flex-1 bg-line" />
      </button>
      {open && (
        <div className="mt-2 rounded-xl bg-muted/60 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-fg-soft">
          {text}
        </div>
      )}
    </div>
  )
}

function MessageList({
  conversation,
  path,
  busy,
}: {
  conversation: ConversationDTO
  path: ReturnType<typeof activePath>
  busy: boolean
}) {
  const messages = useChat((s) => s.messages[conversation.id])
  const approvals = useChat((s) => s.approvals)
  const { setConversation } = useChat()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Tool results live in the tool messages that follow each assistant step.
  // Match them per step: some gateways reuse call ids like "call_0" across steps.
  const resultsByStep = useMemo(() => {
    const map = new Map<string, Map<string, ToolResultPart>>()
    path.forEach((m, i) => {
      if (m.role !== 'assistant') return
      const results = new Map<string, ToolResultPart>()
      for (const t of path.slice(i + 1)) {
        if (t.role !== 'tool') break
        for (const p of t.parts)
          if (p.type === 'tool_result')
            results.set(p.id, { output: p.output, isError: p.isError, images: p.images })
      }
      map.set(m.id, results)
    })
    return map
  }, [path])

  // User messages after which the agent changed files that can be put back.
  const undoable = useMemo(() => {
    const ids = new Set<string>()
    let after = false
    for (const m of [...path].reverse()) {
      if (m.parts.some((p) => p.type === 'tool_result' && p.backups?.length)) after = true
      if (m.role === 'user' && after) ids.add(m.id)
    }
    return ids
  }, [path])

  const { projects, notify } = useApp()
  const root = projects.find((p) => p.id === conversation.projectId)?.rootPath
  const [rewind, setRewind] = useState<{
    messageId: string
    files: { path: string; action: 'restore' | 'delete' }[]
  } | null>(null)
  const [rewinding, setRewinding] = useState(false)
  const rel = (file: string) =>
    root && file.startsWith(root) ? file.slice(root.length).replace(/^[\\/]/, '') : file

  const startRewind = async (messageId: string) => {
    const files = await attempt(() =>
      invoke('chat.rewindFiles', { conversationId: conversation.id, messageId, dryRun: true }),
    )
    if (!files) return
    if (!files.length) notify('这之后没有可撤销的文件改动')
    else setRewind({ messageId, files })
  }

  const confirmRewind = async () => {
    if (!rewind) return
    setRewinding(true)
    const done = await attempt(() =>
      invoke('chat.rewindFiles', { conversationId: conversation.id, messageId: rewind.messageId }),
    )
    setRewinding(false)
    if (done) {
      setRewind(null)
      notify(`已撤销 ${done.length} 个文件的改动`)
    }
  }

  // Follow the stream only while the user is at the bottom.
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const last = path.at(-1)
  const lastLen = last ? JSON.stringify(last.parts).length : 0
  const approvalCount = Object.keys(approvals).length
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [path.length, lastLen, approvalCount])

  useEffect(() => {
    stick.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversation.id])

  const switchTo = async (messageId: string) => {
    const next = await attempt(() =>
      invoke('chat.switchBranch', { conversationId: conversation.id, messageId }),
    )
    if (next) setConversation(next)
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        {path.map((m, i) => {
          if (m.role === 'system') {
            const summary = m.parts.find((p) => p.type === 'summary')
            return summary?.type === 'summary' ? (
              <SummaryDivider key={m.id} text={summary.text} />
            ) : null
          }
          if (m.role === 'tool') return null
          const sibs = siblingsOf(messages ?? [], m)
          const index = sibs.findIndex((s) => s.id === m.id)
          const branch = {
            index,
            total: sibs.length,
            onPrev: () => sibs[index - 1] && void switchTo(sibs[index - 1]!.id),
            onNext: () => sibs[index + 1] && void switchTo(sibs[index + 1]!.id),
          }
          if (m.role === 'user') {
            return (
              <div key={m.id} className={clsx(i > 0 && 'mt-8')}>
                <UserMessage
                  message={m}
                  branch={branch}
                  busy={busy}
                  onRewind={undoable.has(m.id) ? () => void startRewind(m.id) : undefined}
                  onEdit={(text, attachments) =>
                    succeeded(() =>
                      invoke('chat.edit', {
                        conversationId: conversation.id,
                        userMessageId: m.id,
                        text,
                        attachments,
                      }),
                    )
                  }
                />
              </div>
            )
          }
          // An agent turn is several assistant/tool messages; actions go on its last one.
          const next = path.slice(i + 1).find((x) => x.role !== 'tool')
          const endOfTurn = !next || next.role === 'user'
          const userId = path.slice(0, i).findLast((x) => x.role === 'user')?.id
          return (
            <div key={m.id} className={clsx(path[i - 1]?.role === 'user' ? 'mt-6' : 'mt-2')}>
              <AssistantMessage
                message={m}
                branch={branch}
                busy={busy}
                results={resultsByStep.get(m.id) ?? EMPTY}
                approvals={approvals}
                endOfTurn={endOfTurn}
                onRegenerate={() =>
                  userId &&
                  void attempt(() =>
                    invoke('chat.regenerate', {
                      conversationId: conversation.id,
                      userMessageId: userId,
                    }),
                  )
                }
              />
            </div>
          )
        })}
      </div>
      <Modal open={!!rewind} onClose={() => setRewind(null)} title="撤销文件改动">
        {rewind && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-fg-soft">
              以下文件会恢复到发送这条消息时的状态，Agent
              新建的文件会被删除。之后你自己对这些文件的修改也会被覆盖；
              通过命令（bash）产生的改动不会撤销。对话记录保持不变。
            </p>
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-line p-2 font-mono text-[12.5px]">
              {rewind.files.map((f) => (
                <li key={f.path} className="flex gap-2">
                  <span className={f.action === 'delete' ? 'text-red-600' : 'text-fg-faint'}>
                    {f.action === 'delete' ? '删除' : '恢复'}
                  </span>
                  <span className="min-w-0 truncate">{rel(f.path)}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRewind(null)}>
                取消
              </Button>
              <Button variant="danger" loading={rewinding} onClick={() => void confirmRewind()}>
                撤销 {rewind.files.length} 个文件
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function ConversationSettings({
  open,
  conversation,
  onClose,
  onSave,
}: {
  open: boolean
  conversation: ConversationDTO
  onClose: () => void
  onSave: (patch: SettingsPatch) => Promise<void>
}) {
  return (
    <Modal open={open} onClose={onClose} title="对话设置">
      {/* Keyed so the form re-initialises from the conversation each time it opens. */}
      {open && (
        <SettingsForm
          key={conversation.id}
          conversation={conversation}
          onClose={onClose}
          onSave={onSave}
        />
      )}
    </Modal>
  )
}

interface SettingsPatch {
  title: string | null
  systemPrompt: string | null
  params: { temperature?: number; maxOutputTokens?: number }
}

function SettingsForm({
  conversation,
  onClose,
  onSave,
}: {
  conversation: ConversationDTO
  onClose: () => void
  onSave: (patch: SettingsPatch) => Promise<void>
}) {
  const [title, setTitle] = useState(conversation.title ?? '')
  const [system, setSystem] = useState(conversation.systemPrompt ?? '')
  const [temperature, setTemperature] = useState(conversation.params.temperature?.toString() ?? '')
  const [maxTokens, setMaxTokens] = useState(conversation.params.maxOutputTokens?.toString() ?? '')

  const num = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? undefined : Number(s))

  return (
    <>
      <div className="space-y-4 p-5">
        <Field label="标题">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="系统提示词" hint="对这个对话中的每一轮都生效">
          <Textarea
            rows={5}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            placeholder="例如：你是一名资深前端工程师，回答简洁，优先给出代码。"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Temperature" hint="留空使用模型默认值">
            <Input
              inputMode="decimal"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              placeholder="默认"
            />
          </Field>
          <Field label="最大输出 Tokens" hint="留空使用模型默认值">
            <Input
              inputMode="numeric"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder="默认"
            />
          </Field>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          variant="primary"
          onClick={() =>
            void onSave({
              title: title.trim() || null,
              systemPrompt: system.trim() || null,
              params: { temperature: num(temperature), maxOutputTokens: num(maxTokens) },
            })
          }
        >
          保存
        </Button>
      </div>
    </>
  )
}
