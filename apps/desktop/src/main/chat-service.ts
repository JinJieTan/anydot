import type { ApprovalDecision } from '@aitech/agent'
import { toModelMessages, type MessagePart } from '@aitech/core'
import {
  newestLeafFrom,
  pathToLeaf,
  type ConversationRow,
  type MessageRow,
  type Store,
} from '@aitech/db'
import type {
  AgentRunRequest,
  ApprovalDTO,
  Attachment,
  ChatStreamEvent,
  Settings,
} from '../shared/ipc'
import type { AgentHost, RunHandle } from './agent-host'
import type { BlobStore } from './blobs'
import { decryptKey } from './secrets'

const TITLE_MAX = 40

interface ActiveRun {
  handle: RunHandle | null
  aborted: boolean
  approvals: Map<string, ApprovalDTO>
}

/**
 * Drives a reply for a conversation. Plain chats are a single model turn;
 * project conversations run the coding agent. Each agent step is persisted as
 * an assistant message and each tool result as a tool message, chained by
 * parentId, so the stored tree replays exactly what the model saw.
 */
export class ChatService {
  private runs = new Map<string, ActiveRun>()
  /** "Always allow" keys, per conversation, for this app session. */
  private allowed = new Map<string, string[]>()

  constructor(
    private readonly store: Store,
    private readonly blobs: BlobStore,
    private readonly agent: AgentHost,
    private readonly settings: () => Settings,
    private readonly emit: (event: ChatStreamEvent) => void,
  ) {}

  runningConversations(): string[] {
    return [...this.runs.keys()]
  }

  pendingApprovals(): ApprovalDTO[] {
    return [...this.runs.values()].flatMap((r) => [...r.approvals.values()])
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
    const run = this.runs.get(conversationId)
    if (!run) return
    run.aborted = true
    run.handle?.abort()
  }

  approve(conversationId: string, toolCallId: string, decision: ApprovalDecision): void {
    const run = this.runs.get(conversationId)
    if (!run?.approvals.has(toolCallId)) throw new Error('该操作已不在等待确认')
    run.approvals.delete(toolCallId)
    run.handle?.approve(toolCallId, decision)
    this.emit({ type: 'approval-resolved', conversationId, toolCallId })
  }

  switchBranch(conversationId: string, messageId: string): ConversationRow {
    const all = this.store.listMessages(conversationId)
    if (!all.some((m) => m.id === messageId)) throw new Error('找不到该分支')
    return this.store.updateConversation(conversationId, {
      activeLeafId: newestLeafFrom(all, messageId),
    })
  }

  stopAll(): void {
    for (const id of this.runs.keys()) this.stop(id)
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
    const project = conv.projectId ? this.store.getProject(conv.projectId) : undefined
    const fallback =
      available.find((m) => m.id === project?.defaultModelId) ??
      available.find((m) => m.id === this.settings().defaultModelId) ??
      available[0] ??
      null
    if (!fallback) throw new Error('还没有可用的对话模型，请先在设置中添加服务商并获取模型')
    const updated = this.store.updateConversation(conv.id, { modelId: fallback.id })
    this.emit({ type: 'conversation', conversation: updated })
    return updated
  }

  private credentials(modelId: string) {
    const model = this.store.getModel(modelId)
    if (!model) return null
    const provider = this.store.getProvider(model.providerId)
    const apiKey = provider?.enabled ? decryptKey(provider.keyRef) : null
    if (!provider || !apiKey) return null
    return { model, provider: { baseUrl: provider.baseUrl, apiKey, type: provider.type } }
  }

  private imageModel() {
    const images = this.store.listAvailableModels().filter((m) => m.capabilities.includes('image'))
    const pick = images.find((m) => m.id === this.settings().defaultImageModelId) ?? images[0]
    const creds = pick && this.credentials(pick.id)
    return creds ? { provider: creds.provider, modelId: creds.model.modelId } : undefined
  }

  private reply(conversationId: string, user: MessageRow): void {
    const conv = this.ensureModel(this.store.getConversation(conversationId)!)
    const creds = this.credentials(conv.modelId!)
    const project = conv.projectId ? this.store.getProject(conv.projectId) : undefined

    const run: ActiveRun = { handle: null, aborted: false, approvals: new Map() }
    this.runs.set(conversationId, run)
    this.emit({ type: 'run', conversationId, running: true })

    // Persisted chain for this run: each new message hangs off the previous one.
    let leaf = user.id
    let current: { id: string; parts: MessagePart[] } | null = null

    const addAssistant = (parts: MessagePart[], status: MessageRow['status'], error?: string) => {
      const m = this.store.addMessage({
        conversationId,
        parentId: leaf,
        role: 'assistant',
        parts,
        modelId: creds?.model.modelId ?? null,
        status,
      })
      leaf = m.id
      const final =
        status === 'streaming' ? m : this.store.finishMessage(m.id, { parts, status, error })
      this.emit({
        type: status === 'streaming' ? 'message' : 'done',
        conversationId,
        message: final,
      })
      return m
    }

    const end = (error?: string) => {
      if (current) {
        const m = this.store.finishMessage(current.id, {
          parts: current.parts,
          status: run.aborted ? 'aborted' : 'error',
          error: run.aborted ? null : (error ?? '生成中断'),
        })
        this.emit({ type: 'done', conversationId, message: m })
        current = null
      }
      for (const toolCallId of run.approvals.keys()) {
        this.emit({ type: 'approval-resolved', conversationId, toolCallId })
      }
      this.runs.delete(conversationId)
      this.emit({ type: 'run', conversationId, running: false, error })
    }

    if (!creds) {
      addAssistant([], 'error', '模型或服务商不可用（可能被停用或缺少 Key）')
      end()
      return
    }

    void (async () => {
      try {
        const path = pathToLeaf(this.store.listMessages(conversationId), user.id)
        const messages = await toModelMessages(path, (sha) => this.blobs.read(sha), {
          maxOldToolResultChars: 2000,
          keepRecentToolResults: 20,
        })
        if (run.aborted) return end()

        const request: AgentRunRequest = {
          provider: creds.provider,
          modelId: creds.model.modelId,
          protocol: creds.model.protocol,
          messages,
          temperature: conv.params.temperature,
          maxOutputTokens: conv.params.maxOutputTokens,
          thinking: creds.model.capabilities.includes('reasoning') ? conv.thinking : 'off',
          system: project ? undefined : (conv.systemPrompt ?? undefined),
          agent: project && {
            cwd: project.rootPath,
            mode: project.permissionMode,
            projectName: project.name,
            projectInstructions: project.instructions,
            userSystemPrompt: conv.systemPrompt,
            allowed: this.allowed.get(conversationId) ?? [],
            imageModel: this.imageModel(),
          },
        }

        run.handle = this.agent.run(request, {
          onEvent: (e) => {
            switch (e.type) {
              case 'step-start': {
                const m = addAssistant([], 'streaming')
                current = { id: m.id, parts: [] }
                break
              }
              case 'text':
              case 'reasoning':
                if (!current) break
                appendDelta(current.parts, e.type, e.text)
                this.emit({
                  type: 'delta',
                  conversationId,
                  messageId: current.id,
                  [e.type]: e.text,
                })
                break
              case 'step-end': {
                if (!current) break
                const status = e.error ? 'error' : run.aborted ? 'aborted' : 'complete'
                const m = this.store.finishMessage(current.id, {
                  parts: e.parts,
                  status,
                  usage: e.usage,
                  error: e.error ?? null,
                })
                this.emit({ type: 'done', conversationId, message: m })
                current = null
                break
              }
              case 'tool-result': {
                const m = this.store.addMessage({
                  conversationId,
                  parentId: leaf,
                  role: 'tool',
                  parts: [
                    {
                      type: 'tool_result',
                      id: e.toolCallId,
                      name: e.name,
                      output: e.output,
                      isError: e.isError,
                    },
                  ],
                })
                leaf = m.id
                this.emit({ type: 'message', conversationId, message: m })
                break
              }
            }
          },
          onApproval: (request) => {
            const approval: ApprovalDTO = { ...request, conversationId }
            run.approvals.set(request.toolCallId, approval)
            this.emit({ type: 'approval', approval })
          },
          onEnd: (res) => {
            this.allowed.set(conversationId, res.allowed)
            if (res.status === 'max-steps') addAssistant([], 'error', res.error)
            end(res.status === 'error' ? res.error : undefined)
          },
        })
        // Stop requested while we were preparing.
        if (run.aborted) run.handle.abort()
      } catch (err) {
        addAssistant([], 'error', (err as Error).message)
        end()
      }
    })()
  }
}

function appendDelta(parts: MessagePart[], type: 'text' | 'reasoning', chunk: string) {
  const last = parts.findLast((p) => p.type === type) as
    { type: typeof type; text: string } | undefined
  if (last) last.text += chunk
  else parts.push({ type, text: chunk })
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
