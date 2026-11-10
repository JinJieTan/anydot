import { streamChat, toModelMessages, type MessagePart, type Usage } from '@aitech/core'
import {
  newestLeafFrom,
  pathToLeaf,
  type ConversationRow,
  type MessageRow,
  type Store,
} from '@aitech/db/browser'
import { appendDelta, deriveTitle, userParts } from '../../../desktop/src/shared/chat'
import type { Attachment, ChatStreamEvent, Settings } from '../../../desktop/src/shared/ipc'
import type { WebBlobs } from './blobs'

/**
 * The web counterpart of the desktop's ChatService. Same message tree, same
 * events, but a reply is a single model turn: tools need the local machine,
 * so there is no agent and nothing to approve.
 */
export class WebChatService {
  private runs = new Map<string, AbortController>()

  constructor(
    private readonly store: Store,
    private readonly blobs: WebBlobs,
    private readonly settings: () => Settings,
    private readonly decryptKey: (ref: string | null) => Promise<string | null>,
    private readonly emit: (event: ChatStreamEvent) => void,
  ) {}

  runningConversations(): string[] {
    return [...this.runs.keys()]
  }

  async send(conversationId: string, text: string, attachments: Attachment[]): Promise<void> {
    const parts = userParts(text, attachments)
    if (!parts.length) throw new Error('消息不能为空')
    const conv = this.ensureModel(this.requireIdle(conversationId))
    const user = this.store.addMessage({
      conversationId,
      parentId: conv.activeLeafId,
      role: 'user',
      parts,
    })
    this.emit({ type: 'message', conversationId, message: user })
    if (!conv.title) {
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

  edit(conversationId: string, userMessageId: string, text: string, attachments: Attachment[]) {
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
    this.runs.get(conversationId)?.abort()
  }

  stopAll(): void {
    for (const run of this.runs.values()) run.abort()
  }

  switchBranch(conversationId: string, messageId: string): ConversationRow {
    const all = this.store.listMessages(conversationId)
    if (!all.some((m) => m.id === messageId)) throw new Error('找不到该分支')
    return this.store.updateConversation(conversationId, {
      activeLeafId: newestLeafFrom(all, messageId),
    })
  }

  private requireIdle(conversationId: string): ConversationRow {
    const conv = this.store.getConversation(conversationId)
    if (!conv) throw new Error('对话不存在')
    if (this.runs.has(conversationId)) throw new Error('正在生成回复，请先停止')
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

  private async credentials(modelId: string) {
    const model = this.store.getModel(modelId)
    if (!model) return null
    const provider = this.store.getProvider(model.providerId)
    const apiKey = provider?.enabled ? await this.decryptKey(provider.keyRef) : null
    if (!provider || !apiKey) return null
    return { model, provider: { baseUrl: provider.baseUrl, apiKey, type: provider.type } }
  }

  private reply(conversationId: string, user: MessageRow): void {
    const conv = this.ensureModel(this.store.getConversation(conversationId)!)
    const model = this.store.getModel(conv.modelId!)
    const controller = new AbortController()
    this.runs.set(conversationId, controller)
    this.emit({ type: 'run', conversationId, running: true })

    const assistant = this.store.addMessage({
      conversationId,
      parentId: user.id,
      role: 'assistant',
      parts: [],
      modelId: model?.modelId ?? null,
      status: 'streaming',
    })
    this.emit({ type: 'message', conversationId, message: assistant })

    const parts: MessagePart[] = []
    const finish = (status: MessageRow['status'], error?: string, usage?: Usage | null) => {
      // Reasoning first, as the desktop agent stores a step.
      parts.sort((a, b) => Number(b.type === 'reasoning') - Number(a.type === 'reasoning'))
      const message = this.store.finishMessage(assistant.id, {
        parts,
        status,
        usage,
        error: error ?? null,
      })
      this.emit({ type: 'done', conversationId, message })
      this.runs.delete(conversationId)
      this.emit({ type: 'run', conversationId, running: false, error })
    }

    void (async () => {
      const creds = await this.credentials(conv.modelId!)
      if (!creds || !model) return finish('error', '模型或服务商不可用（可能被停用或缺少 Key）')
      try {
        const path = pathToLeaf(this.store.listMessages(conversationId), user.id)
        const messages = await toModelMessages(path, (sha) => this.blobs.read(sha))
        let usage: Usage | null = null
        let error: string | undefined
        for await (const e of streamChat({
          model: { provider: creds.provider, modelId: model.modelId, protocol: model.protocol },
          messages,
          system: conv.systemPrompt ?? undefined,
          temperature: conv.params.temperature,
          maxOutputTokens: conv.params.maxOutputTokens,
          thinking: model.capabilities.includes('reasoning') ? conv.thinking : 'off',
          signal: controller.signal,
        })) {
          if (e.type === 'text' || e.type === 'reasoning') {
            appendDelta(parts, e.type, e.text)
            this.emit({
              type: 'delta',
              conversationId,
              messageId: assistant.id,
              [e.type]: e.text,
            })
          } else if (e.type === 'finish') usage = e.usage
          else if (e.type === 'error') error = e.message
        }
        if (controller.signal.aborted) finish('aborted', undefined, usage)
        else if (error) finish('error', error, usage)
        else finish('complete', undefined, usage)
      } catch (err) {
        finish(controller.signal.aborted ? 'aborted' : 'error', (err as Error).message)
      }
    })()
  }
}
