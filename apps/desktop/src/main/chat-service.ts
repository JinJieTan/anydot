import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentEvent, ApprovalDecision, FileBackup } from '@aitech/agent'
import { base64ToBytes, toModelMessages, type MessagePart, type ToolImage } from '@aitech/core'
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
import { computerPermissions } from './computer-permissions'
import { decryptKey } from './secrets'

const TITLE_MAX = 40

/** Where a request came from; remote (phone) requests get stricter defaults. */
export type Origin = 'local' | 'remote'

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

  send(
    conversationId: string,
    text: string,
    attachments: Attachment[],
    origin: Origin = 'local',
  ): void {
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
    this.reply(conversationId, user, origin)
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

  /** Stop the background jobs (dev servers etc.) a conversation's agent started. */
  clearJobs(conversationId: string): void {
    this.agent.clearJobs(conversationId)
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

  private async saveImages(images: ToolImage[]) {
    return Promise.all(
      images.map(async (img) => ({
        blob: await this.blobs.put(
          typeof img.data === 'string' ? base64ToBytes(img.data) : img.data,
          img.mime,
        ),
        mime: img.mime,
      })),
    )
  }

  private async saveBackups(backups: FileBackup[]) {
    return Promise.all(
      backups.map(async (b) => ({
        path: b.path,
        blob: b.data ? await this.blobs.put(b.data, 'application/octet-stream') : null,
      })),
    )
  }

  /**
   * Undo the agent's file changes made after a user message on the active
   * branch: every file goes back to its content at that point (files the
   * agent created are deleted). `dryRun` only lists what would change.
   * Changes made by shell commands aren't tracked and stay as they are.
   */
  async rewindFiles(
    conversationId: string,
    messageId: string,
    dryRun: boolean,
  ): Promise<{ path: string; action: 'restore' | 'delete' }[]> {
    const conv = this.requireIdle(conversationId)
    const path = conv.activeLeafId
      ? pathToLeaf(this.store.listMessages(conversationId), conv.activeLeafId)
      : []
    const from = path.findIndex((m) => m.id === messageId)
    if (from < 0) throw new Error('这条消息不在当前分支上')

    // The first backup of each file after the message is its content at that point.
    const targets = new Map<string, string | null>()
    for (const m of path.slice(from))
      for (const p of m.parts)
        if (p.type === 'tool_result')
          for (const b of p.backups ?? []) if (!targets.has(b.path)) targets.set(b.path, b.blob)

    const plan = [...targets].map(([file, blob]) => ({
      path: file,
      blob,
      action: blob ? ('restore' as const) : ('delete' as const),
    }))
    if (!dryRun) {
      // Load every backup first, so a missing one (e.g. after an import) changes nothing.
      const contents = await Promise.all(
        plan.map((f) =>
          f.blob
            ? this.blobs.read(f.blob).catch(() => {
                throw new Error(`找不到 ${f.path} 的备份，无法撤销`)
              })
            : null,
        ),
      )
      for (const [i, f] of plan.entries()) {
        const data = contents[i]
        if (data) {
          await mkdir(dirname(f.path), { recursive: true })
          await writeFile(f.path, data)
        } else {
          await rm(f.path, { force: true })
        }
      }
    }
    return plan.map(({ path: p, action }) => ({ path: p, action }))
  }

  private reply(conversationId: string, user: MessageRow, origin: Origin = 'local'): void {
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
            conversationId,
            cwd: project.rootPath,
            // Tasks started from a phone never run fully unattended: commands still need a tap.
            mode:
              origin === 'remote' && project.permissionMode === 'auto'
                ? 'auto-edit'
                : project.permissionMode,
            projectName: project.name,
            projectInstructions: project.instructions,
            userSystemPrompt: conv.systemPrompt,
            allowed: this.allowed.get(conversationId) ?? [],
            sandbox: this.settings().sandbox,
            browser: this.settings().browserTool,
            computer: this.settings().computerUse,
            computerBlocked: this.settings().computerUse ? computerBlocked() : undefined,
            imageModel: this.imageModel(),
          },
        }

        const onEvent = (
          e: AgentEvent,
          extra?: {
            images: { blob: string; mime: string }[]
            backups: { path: string; blob: string | null }[]
          },
        ) => {
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
            case 'compacted': {
              // Later requests start from this summary instead of the full history.
              const m = this.store.addMessage({
                conversationId,
                parentId: leaf,
                role: 'system',
                parts: [{ type: 'summary', text: e.summary }],
              })
              leaf = m.id
              this.emit({ type: 'message', conversationId, message: m })
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
                    ...(extra?.images.length ? { images: extra.images } : {}),
                    ...(extra?.backups.length ? { backups: extra.backups } : {}),
                  },
                ],
              })
              leaf = m.id
              this.emit({ type: 'message', conversationId, message: m })
              break
            }
          }
        }

        // Events are handled strictly in order, even while a screenshot is being saved.
        let queue: Promise<void> = Promise.resolve()
        const inOrder = (fn: () => void | Promise<void>) => {
          queue = queue.then(fn).catch((err) => console.error('[chat] event failed', err))
        }

        run.handle = this.agent.run(request, {
          onEvent: (e) =>
            inOrder(async () => {
              if (e.type === 'tool-result' && (e.images?.length || e.backups?.length)) {
                const extra = {
                  images: e.images?.length ? await this.saveImages(e.images).catch(() => []) : [],
                  backups: e.backups?.length
                    ? await this.saveBackups(e.backups).catch(() => [])
                    : [],
                }
                onEvent({ ...e, images: undefined, backups: undefined }, extra)
              } else onEvent(e)
            }),
          onApproval: (request) => {
            const approval: ApprovalDTO = { ...request, conversationId }
            run.approvals.set(request.toolCallId, approval)
            this.emit({ type: 'approval', approval })
          },
          onEnd: (res) =>
            inOrder(() => {
              this.allowed.set(conversationId, res.allowed)
              if (res.status === 'max-steps') addAssistant([], 'error', res.error)
              end(res.status === 'error' ? res.error : undefined)
            }),
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

/** A message for the model when macOS permissions for computer use are missing. */
function computerBlocked(): string | undefined {
  const p = computerPermissions()
  const missing = [
    !p.accessibility && '辅助功能（Accessibility）',
    p.screen !== 'granted' && '录屏与系统录音（Screen Recording）',
  ].filter(Boolean)
  if (!missing.length) return undefined
  return (
    `Computer use is missing macOS permissions: ${missing.join('、')}. ` +
    'Tell the user to grant them in aitech 设置 → Agent 能力, then try again.'
  )
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
