import clsx from 'clsx'
import { Settings2, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ConversationDTO, Rpc } from '../../../shared/ipc'
import { Composer } from '../components/Composer'
import { AssistantMessage, UserMessage } from '../components/Message'
import { ModelPicker, ThinkingPicker } from '../components/ModelPicker'
import { Button, Field, IconButton, Input, Modal, Textarea } from '../components/ui'
import { invoke, isMac } from '../lib/api'
import { activePath, siblingsOf } from '../lib/tree'
import { attempt, succeeded, useApp } from '../store/app'
import { useChat } from '../store/chat'

export function ChatView() {
  const { activeId, running, models, providers, settings, setView, open } = useApp()
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
    const ok = await succeeded(() => invoke('chat.send', { conversationId: id, text, attachments }))
    return ok
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
    </>
  )

  const composer = (
    <Composer
      running={isRunning}
      autoFocus
      toolbar={toolbar}
      onSend={send}
      onStop={() => activeId && void invoke('chat.stop', activeId)}
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
                <Sparkles className="size-6" />
              </div>
              <h1 className="text-2xl font-semibold">有什么可以帮你？</h1>
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
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {conversation.title || '新对话'}
        </h1>
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

function MessageList({
  conversation,
  path,
  busy,
}: {
  conversation: ConversationDTO
  path: ReturnType<typeof activePath>
  busy: boolean
}) {
  const messages = useChat((s) => s.messages[conversation.id] ?? [])
  const { setConversation } = useChat()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Follow the stream only while the user is at the bottom.
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const last = path.at(-1)
  const lastLen = last ? JSON.stringify(last.parts).length : 0
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [path.length, lastLen])

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
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        {path.map((m) => {
          const sibs = siblingsOf(messages, m)
          const index = sibs.findIndex((s) => s.id === m.id)
          const branch = {
            index,
            total: sibs.length,
            onPrev: () => sibs[index - 1] && void switchTo(sibs[index - 1]!.id),
            onNext: () => sibs[index + 1] && void switchTo(sibs[index + 1]!.id),
          }
          if (m.role === 'user') {
            return (
              <UserMessage
                key={m.id}
                message={m}
                branch={branch}
                busy={busy}
                onEdit={async (text, attachments) => {
                  const ok = await succeeded(() =>
                    invoke('chat.edit', {
                      conversationId: conversation.id,
                      userMessageId: m.id,
                      text,
                      attachments,
                    }),
                  )
                  return ok
                }}
              />
            )
          }
          if (m.role === 'assistant') {
            return (
              <AssistantMessage
                key={m.id}
                message={m}
                branch={branch}
                busy={busy}
                onRegenerate={() =>
                  m.parentId &&
                  void attempt(() =>
                    invoke('chat.regenerate', {
                      conversationId: conversation.id,
                      userMessageId: m.parentId!,
                    }),
                  )
                }
              />
            )
          }
          return null
        })}
      </div>
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
