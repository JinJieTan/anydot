/**
 * IPC contract shared by main, preload and renderer.
 *
 * Every renderer → main call goes through `invoke(method, ...args)`; the
 * preload only forwards method names listed in RPC_METHODS. Keys never cross
 * into the renderer: providers expose `hasKey` / `keyHint` instead.
 */
import type {
  Capability,
  MessagePart,
  Protocol,
  ProviderType,
  ThinkingLevel,
  Usage,
} from '@aitech/core'
import type {
  ConversationParams,
  ConversationRow,
  ImageJobParams,
  ImageJobRow,
  MessageRow,
  ModelRow,
} from '@aitech/db'

export interface AppInfo {
  version: string
  platform: string
  versions: { electron: string; chrome: string; node: string }
  db: { path: string; schemaVersion: number }
  keyStorage: 'os' | 'plain'
}

export interface ProviderDTO {
  id: string
  name: string
  baseUrl: string
  type: ProviderType
  enabled: boolean
  hasKey: boolean
  /** e.g. "sk-…a1b2", safe to display */
  keyHint: string | null
}

export type ModelDTO = ModelRow
export type ConversationDTO = ConversationRow
export type MessageDTO = MessageRow
export type ImageJobDTO = ImageJobRow

export interface ProviderInput {
  name: string
  baseUrl: string
  type: ProviderType
  /** Omit to keep the stored key when updating. */
  apiKey?: string
}

export interface TestResult {
  ok: boolean
  models?: number
  error?: string
}

export interface Attachment {
  blob: string
  mime: string
  name: string
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  defaultModelId: string | null
  defaultImageModelId: string | null
  defaultThinking: ThinkingLevel
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  defaultModelId: null,
  defaultImageModelId: null,
  defaultThinking: 'off',
}

export interface ConversationDetail {
  conversation: ConversationDTO
  messages: MessageDTO[]
}

export interface ImageGenerateInput {
  modelId: string
  prompt: string
  params: ImageJobParams
  sourceBlobIds: string[]
}

export interface ImportResult {
  conversations: number
  messages: number
  imageJobs: number
  providers: number
}

export interface Rpc {
  'app.info': () => AppInfo

  'settings.get': () => Settings
  'settings.set': (patch: Partial<Settings>) => Settings

  'providers.list': () => ProviderDTO[]
  'providers.create': (input: ProviderInput) => ProviderDTO
  'providers.update': (
    id: string,
    input: Partial<ProviderInput> & { enabled?: boolean },
  ) => ProviderDTO
  'providers.delete': (id: string) => void
  /**
   * Test connectivity. Fields given override the saved provider `id`, so an
   * edit form can test a changed URL while keeping the stored key.
   */
  'providers.test': (target: { id?: string } & Partial<ProviderInput>) => TestResult
  'providers.syncModels': (id: string) => { added: number; total: number }

  'models.list': (providerId?: string) => ModelDTO[]
  'models.available': () => ModelDTO[]
  'models.add': (input: {
    providerId: string
    modelId: string
    protocol?: Protocol | null
  }) => ModelDTO
  'models.update': (
    id: string,
    patch: {
      enabled?: boolean
      protocol?: Protocol | null
      displayName?: string | null
      capabilities?: Capability[]
    },
  ) => ModelDTO
  'models.delete': (id: string) => void

  'conversations.list': (opts?: { search?: string }) => ConversationDTO[]
  'conversations.get': (id: string) => ConversationDetail | null
  'conversations.create': (input?: { modelId?: string | null }) => ConversationDTO
  'conversations.update': (
    id: string,
    patch: {
      title?: string | null
      modelId?: string | null
      systemPrompt?: string | null
      params?: ConversationParams
      thinking?: ThinkingLevel
      pinned?: boolean
    },
  ) => ConversationDTO
  'conversations.delete': (id: string) => void

  /** Start a new user turn on the active branch. */
  'chat.send': (input: { conversationId: string; text: string; attachments: Attachment[] }) => void
  /** Re-run the assistant reply to a user message, as a new sibling branch. */
  'chat.regenerate': (input: { conversationId: string; userMessageId: string }) => void
  /** Edit a user message: creates a sibling user message and replies to it. */
  'chat.edit': (input: {
    conversationId: string
    userMessageId: string
    text: string
    attachments: Attachment[]
  }) => void
  'chat.stop': (conversationId: string) => void
  /** Make the newest leaf below `messageId` the active branch. */
  'chat.switchBranch': (input: { conversationId: string; messageId: string }) => ConversationDTO
  'chat.running': () => string[]

  'blobs.put': (input: { data: Uint8Array; mime: string; name: string }) => Attachment
  'blobs.saveAs': (input: { sha256: string; suggestedName: string }) => boolean
  'blobs.copyImage': (sha256: string) => void

  'images.list': () => ImageJobDTO[]
  'images.generate': (input: ImageGenerateInput) => ImageJobDTO
  'images.delete': (id: string) => void

  'data.export': () => { path: string } | null
  'data.import': () => ImportResult | null
}

export type RpcMethod = keyof Rpc

export const RPC_METHODS: readonly RpcMethod[] = [
  'app.info',
  'settings.get',
  'settings.set',
  'providers.list',
  'providers.create',
  'providers.update',
  'providers.delete',
  'providers.test',
  'providers.syncModels',
  'models.list',
  'models.available',
  'models.add',
  'models.update',
  'models.delete',
  'conversations.list',
  'conversations.get',
  'conversations.create',
  'conversations.update',
  'conversations.delete',
  'chat.send',
  'chat.regenerate',
  'chat.edit',
  'chat.stop',
  'chat.switchBranch',
  'chat.running',
  'blobs.put',
  'blobs.saveAs',
  'blobs.copyImage',
  'images.list',
  'images.generate',
  'images.delete',
  'data.export',
  'data.import',
]

/** Main → renderer push events. */
export type ChatStreamEvent =
  | { type: 'message'; conversationId: string; message: MessageDTO }
  | { type: 'delta'; conversationId: string; messageId: string; text?: string; reasoning?: string }
  | { type: 'done'; conversationId: string; message: MessageDTO }
  | { type: 'conversation'; conversation: ConversationDTO }

export interface Events {
  chat: ChatStreamEvent
  image: ImageJobDTO
  /** Something changed outside the current view (import, provider edits). */
  invalidate: { scope: 'conversations' | 'providers' | 'models' | 'images' | 'all' }
}

export type EventName = keyof Events

export const EVENT_CHANNEL = (name: EventName) => `event:${name}`

/** Messages between main and the agent utilityProcess. */
export interface AgentChatStart {
  type: 'chat.start'
  runId: string
  request: {
    provider: { baseUrl: string; apiKey: string; type: ProviderType }
    modelId: string
    protocol: Protocol | null
    messages: unknown[]
    system?: string
    temperature?: number
    maxOutputTokens?: number
    thinking: ThinkingLevel
  }
}

export type AgentRequest =
  { type: 'ping'; id: string } | AgentChatStart | { type: 'chat.abort'; runId: string }

export type AgentResponse =
  | { type: 'pong'; id: string; pid: number }
  | {
      type: 'chat.event'
      runId: string
      event:
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; id: string; name: string; input: unknown }
        | { type: 'finish'; usage: Usage; finishReason: string }
        | { type: 'error'; message: string }
    }
  | { type: 'chat.end'; runId: string; aborted: boolean }

export type { MessagePart }
