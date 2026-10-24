import { AlertCircle, Brain, Loader2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  generateImages,
  listModels,
  resolveProtocol,
  streamChat,
  type ModelMessage,
  type RemoteModel,
} from '@aitech/core'
import { Composer, type ImageDraft } from '../components/Composer'
import { Markdown } from '../components/Markdown'
import { Header } from '../components/ui'
import type { LocalChat, LocalMessage } from '../lib/storage'
import { attempt, useApp } from '../store/app'

let modelCache: { key: string; models: RemoteModel[] } | null = null

function toModelMessages(messages: LocalMessage[]): ModelMessage[] {
  return messages
    .filter((m) => !m.error && (m.text || m.images?.length))
    .map((m) =>
      m.role === 'user'
        ? {
            role: 'user' as const,
            content: [
              ...(m.images ?? []).map((url) => ({ type: 'image' as const, image: url })),
              ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
            ],
          }
        : { role: 'assistant' as const, content: m.text || '[图片]' },
    )
}

export function LocalChatScreen({ chatId }: { chatId: string }) {
  const { chats, settings, saveChat } = useApp()
  const stored = chats.find((c) => c.id === chatId)
  const [chat, setChat] = useState<LocalChat | undefined>(stored)
  const [models, setModels] = useState<RemoteModel[]>(modelCache?.models ?? [])
  const [running, setRunning] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => setChat(stored), [stored])

  useEffect(() => {
    const key = `${settings.baseUrl}|${settings.apiKey}`
    if (modelCache?.key === key) return
    void attempt(() => listModels(settings.baseUrl, settings.apiKey)).then((list) => {
      if (!list) return
      modelCache = { key, models: list }
      setModels(list)
    })
  }, [settings.baseUrl, settings.apiKey])

  const lastLen = chat?.messages.at(-1)?.text.length ?? 0
  useLayoutEffect(() => {
    const el = document.scrollingElement
    if (el) el.scrollTop = el.scrollHeight
  }, [chat?.messages.length, lastLen])

  if (!chat) return <Header title="对话不存在" backTo="/chats" />

  const usable = models.filter(
    (m) => m.capabilities.includes('chat') || m.capabilities.includes('image'),
  )
  const modelId = chat.modelId ?? usable.find((m) => m.capabilities.includes('chat'))?.id ?? null
  const isImage = !!modelId && resolveProtocol(modelId, settings.providerType) === 'openai-images'

  const persist = (c: LocalChat) => {
    setChat(c)
    void saveChat(c)
  }

  const send = async (text: string, images: ImageDraft[]): Promise<boolean> => {
    if (!modelId) return false
    const user: LocalMessage = {
      role: 'user',
      text: text.trim(),
      images: images.map((i) => i.preview),
    }
    let current: LocalChat = {
      ...chat,
      modelId,
      title: chat.messages.length ? chat.title : text.trim().slice(0, 30) || '图片对话',
      messages: [...chat.messages, user, { role: 'assistant', text: '' }],
      updatedAt: Date.now(),
    }
    persist(current)
    setRunning(true)
    const controller = new AbortController()
    abort.current = controller
    const update = (patch: Partial<LocalMessage>) => {
      const msgs = current.messages.slice()
      msgs[msgs.length - 1] = { ...msgs[msgs.length - 1]!, ...patch }
      current = { ...current, messages: msgs, updatedAt: Date.now() }
      setChat(current)
    }

    try {
      if (isImage) {
        const res = await generateImages({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: modelId,
          prompt: user.text || '基于参考图生成',
          images: images.map((i) => ({
            data: Uint8Array.from(atob(i.data), (ch) => ch.charCodeAt(0)),
            mime: i.mime,
            name: i.name,
          })),
          signal: controller.signal,
        })
        const urls = await Promise.all(
          res.images.map(
            (img) =>
              new Promise<string>((resolve) => {
                const r = new FileReader()
                r.onload = () => resolve(String(r.result))
                r.readAsDataURL(new Blob([new Uint8Array(img.data)], { type: img.mime }))
              }),
          ),
        )
        update({ images: urls, text: '' })
      } else {
        let out = ''
        let reasoning = ''
        for await (const e of streamChat({
          model: {
            provider: {
              baseUrl: settings.baseUrl,
              apiKey: settings.apiKey,
              type: settings.providerType,
            },
            modelId,
          },
          messages: toModelMessages(current.messages.slice(0, -1)),
          signal: controller.signal,
        })) {
          if (e.type === 'text') update({ text: (out += e.text) })
          else if (e.type === 'reasoning') update({ reasoning: (reasoning += e.text) })
          else if (e.type === 'error') update({ error: e.message })
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) update({ error: (err as Error).message })
    } finally {
      setRunning(false)
      abort.current = null
      void saveChat(current)
    }
    return true
  }

  return (
    <div className="flex flex-1 flex-col">
      <Header
        title={chat.title}
        backTo="/chats"
        right={
          <select
            value={modelId ?? ''}
            onChange={(e) => persist({ ...chat, modelId: e.target.value })}
            className="mr-1 max-w-40 truncate rounded-lg bg-muted px-2 py-1.5 text-[13px] outline-none"
          >
            {!usable.length && <option value="">加载模型…</option>}
            {usable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        }
      />
      <div className="flex-1 space-y-4 px-4 py-4">
        {chat.messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex flex-col items-end gap-1.5">
              {m.images?.map((u, j) => (
                <img
                  key={j}
                  src={u}
                  alt=""
                  className="max-h-48 max-w-[70%] rounded-xl object-cover"
                />
              ))}
              {m.text && (
                <div className="max-w-[85%] rounded-2xl bg-accent px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-white">
                  {m.text}
                </div>
              )}
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {m.reasoning && (
                <details className="text-[13px] text-fg-faint">
                  <summary className="flex items-center gap-1">
                    <Brain className="size-3.5" />
                    思考过程
                  </summary>
                  <div className="mt-1 border-l-2 border-line pl-3 whitespace-pre-wrap">
                    {m.reasoning}
                  </div>
                </details>
              )}
              {m.text && <Markdown text={m.text} />}
              {m.images?.map((u, j) => (
                <a key={j} href={u} download={`anydot-${j + 1}.png`}>
                  <img src={u} alt="生成的图片" className="w-full rounded-xl" />
                </a>
              ))}
              {m.error && (
                <div className="flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span className="break-all">{m.error}</span>
                </div>
              )}
              {running &&
                i === chat.messages.length - 1 &&
                !m.text &&
                !m.images?.length &&
                !m.error && <Loader2 className="size-4 animate-spin text-fg-faint" />}
            </div>
          ),
        )}
        {!chat.messages.length && (
          <div className="py-12 text-center text-sm text-fg-faint">
            {isImage ? '描述你想要的画面，可以附上参考图。' : '发送消息开始对话。'}
          </div>
        )}
      </div>
      <div className="sticky bottom-0">
        <Composer
          placeholder={isImage ? '描述画面…' : '输入消息…'}
          running={running}
          disabled={!modelId}
          onSend={send}
          onStop={() => abort.current?.abort()}
        />
      </div>
    </div>
  )
}
