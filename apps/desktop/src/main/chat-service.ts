import { toModelMessages, type MessagePart, type Usage } from '@aitech/core'
import {
  newestLeafFrom,
  pathToLeaf,
  type ConversationRow,
  type MessageRow,
  type Store,
} from '@aitech/db'
import type { Attachment, ChatStreamEvent, Settings } from '../shared/ipc'
import type { AgentHost } from './agent-host'
import type { BlobStore } from './blobs'
import { decryptKey } from './secrets'

const TITLE_MAX = 40

export class ChatService {
  /** conversationId → abort function for the in-flight reply */
  private running = new Map<string, () => void>()

  constructor(
    private readonly store: Store,
    private readonly blobs: BlobStore,
    private readonly agent: AgentHost,
    private readonly settings: () => Settings,
    private readonly emit: (event: ChatStreamEvent) => void,
  ) {}

  runningConversations(): string[] {
    return [...this.running.keys()]
  }

  send(conversationId: string, text: string, attachments: Attachment[]): void {
    const conv = this.requireIdle(conversationId)
    const parts = userParts(text, attachments)
    if (!parts.length) throw new Error('消息不能为空')

    const withModel = this.ensureModel(conv)
    const user = this.store.addMessage({
      conversationId,
      parentId: withModel.activeLeafId,
      role: 'user',
      parts,
    })
    this.emit({ type: 'message', conversationId, message: user })

    if (!withModel.title) {
      const title = deriveTitle(text, attachments)
      this.emit({
        type: 'conversation',
        conversation: this.store.updateConversation(conversationId, { title }),
      })
    }
    this.reply(conversationId, user)
  }

  regenerate(conversationId: string, userMessageId: string): void {
    this.requireIdle(conversationId)
    const user = this.store.getMessage(userMessageId)
    if (!user || user.role !== 'user' || user.conversationId !== conversationId) {
      throw new Error('找不到要重新生成的消息')
    }
    this.reply(conversationId, user)
  }

  edit(
    conversationId: string,
    userMessageId: string,
    text: string,
    attachments: Attachment[],
  ): void {
    this.requireIdle(conversationId)
    const original = this.store.getMessage(userMessageId)
    if (!original || original.role !== 'user' || original.conversationId !== conversationId) {
      throw new Error('找不到要编辑的消息')
    }
    const parts = userParts(text, attachments)
    if (!parts.length) throw new Error('消息不能为空')
    const user = this.store.addMessage({
      conversationId,
      parentId: original.parentId,
      role: 'user',
      parts,
    })
    this.emit({ type: 'message', conversationId, message: user })
    this.reply(conversationId, user)
  }

  stop(conversationId: string): void {
    this.running.get(conversationId)?.()
  }

  switchBranch(conversationId: string, messageId: string): ConversationRow {
    const all = this.store.listMessages(conversationId)
    if (!all.some((m) => m.id === messageId)) throw new Error('找不到该分支')
    return this.store.updateConversation(conversationId, {
      activeLeafId: newestLeafFrom(all, messageId),
    })
  }

  stopAll(): void {
    for (const abort of this.running.values()) abort()
  }

  private requireIdle(conversationId: string): ConversationRow {
    const conv = this.store.getConversation(conversationId)
    if (!conv) throw new Error('对话不存在')
    if (this.running.has(conversationId)) throw new Error('正在生成回复，请先停止')
    return conv
  }

  /** Make sure the conversation has a usable model, falling back to the default. */
  private ensureModel(conv: ConversationRow): ConversationRow {
    const available = this.store
      .listAvailableModels()
      .filter((m) => m.capabilities.includes('chat'))
    if (conv.modelId && available.some((m) => m.id === conv.modelId)) return conv
    const fallback =
      available.find((m) => m.id === this.settings().defaultModelId) ?? available[0] ?? null
    if (!fallback) throw new Error('还没有可用的对话模型，请先在设置中添加服务商并获取模型')
    const updated = this.store.updateConversation(conv.id, { modelId: fallback.id })
    this.emit({ type: 'conversation', conversation: updated })
    return updated
  }

  private reply(conversationId: string, user: MessageRow): void {
    const conv = this.ensureModel(this.store.getConversation(conversationId)!)
    const model = this.store.getModel(conv.modelId!)!
    const provider = this.store.getProvider(model.providerId)
    const apiKey = provider && decryptKey(provider.keyRef)

    const assistant = this.store.addMessage({
      conversationId,
      parentId: user.id,
      role: 'assistant',
      parts: [],
      modelId: model.modelId,
      status: 'streaming',
    })
    this.emit({ type: 'message', conversationId, message: assistant })

    if (!provider || !apiKey) {
      this.finish(conversationId, assistant.id, [], 'error', null, '服务商未配置 Key')
      return
    }

    let text = ''
    let reasoning = ''
    const toolCalls: MessagePart[] = []
    let usage: Usage | null = null
    let error: string | null = null

    const parts = (): MessagePart[] => [
      ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls,
    ]

    // Register before any await so a quick second send is rejected.
    let abort: (() => void) | null = null
    let aborted = false
    this.running.set(conversationId, () => {
      aborted = true
      abort?.()
    })

    void (async () => {
      try {
        const path = pathToLeaf(this.store.listMessages(conversationId), user.id)
        const messages = await toModelMessages(path, (sha) => this.blobs.read(sha))
        if (aborted) {
          this.finish(conversationId, assistant.id, [], 'aborted', null, null)
          return
        }
        abort = this.agent.chat(
          {
            provider: { baseUrl: provider.baseUrl, apiKey, type: provider.type },
            modelId: model.modelId,
            protocol: model.protocol,
            messages,
            system: conv.systemPrompt ?? undefined,
            temperature: conv.params.temperature,
            maxOutputTokens: conv.params.maxOutputTokens,
            thinking: model.capabilities.includes('reasoning') ? conv.thinking : 'off',
          },
          {
            onEvent: (e) => {
              switch (e.type) {
                case 'text':
                  text += e.text
                  this.emit({
                    type: 'delta',
                    conversationId,
                    messageId: assistant.id,
                    text: e.text,
                  })
                  break
                case 'reasoning':
                  reasoning += e.text
                  this.emit({
                    type: 'delta',
                    conversationId,
                    messageId: assistant.id,
                    reasoning: e.text,
                  })
                  break
                case 'tool-call':
                  toolCalls.push({ type: 'tool_call', id: e.id, name: e.name, input: e.input })
                  break
                case 'finish':
                  usage = e.usage
                  break
                case 'error':
                  error = e.message
                  break
              }
            },
            onEnd: (wasAborted) => {
              const status = error ? 'error' : wasAborted || aborted ? 'aborted' : 'complete'
              this.finish(conversationId, assistant.id, parts(), status, usage, error)
            },
          },
        )
      } catch (err) {
        this.finish(conversationId, assistant.id, parts(), 'error', null, (err as Error).message)
      }
    })()
  }

  private finish(
    conversationId: string,
    messageId: string,
    parts: MessagePart[],
    status: MessageRow['status'],
    usage: Usage | null,
    error: string | null,
  ) {
    this.running.delete(conversationId)
    const message = this.store.finishMessage(messageId, { parts, status, usage, error })
    this.emit({ type: 'done', conversationId, message })
  }
}

function userParts(text: string, attachments: Attachment[]): MessagePart[] {
  const parts: MessagePart[] = attachments.map((a) =>
    a.mime.startsWith('image/')
      ? { type: 'image', blob: a.blob, mime: a.mime, name: a.name }
      : { type: 'file', blob: a.blob, mime: a.mime, name: a.name },
  )
  const trimmed = text.trim()
  if (trimmed) parts.push({ type: 'text', text: trimmed })
  return parts
}

export function deriveTitle(text: string, attachments: Attachment[] = []): string {
  const line = text.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? ''
  if (line) return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line
  return attachments[0]?.name ?? '新对话'
}
