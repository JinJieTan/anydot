/**
 * IPC contract shared by main, preload and renderer.
 *
 * Every renderer → main call goes through `invoke(method, ...args)`; the
 * preload only forwards method names listed in RPC_METHODS. Keys never cross
 * into the renderer: providers expose `hasKey` / `keyHint` instead.
 */
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  McpServerConfig,
  McpServerStatus,
} from '@aitech/agent'
import type { Capability, MessagePart, Protocol, ProviderType, ThinkingLevel } from '@aitech/core'
import type {
  ConversationParams,
  ConversationRow,
  ImageJobParams,
  ImageJobRow,
  MessageRow,
  ModelRow,
  PermissionMode,
  ProjectRow,
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
export type ProjectDTO = ProjectRow
export type { ApprovalDecision, PermissionMode }

/** A tool call waiting for the user's decision. */
export interface ApprovalDTO extends ApprovalRequest {
  conversationId: string
}

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
  /** Run agent commands in the OS sandbox (macOS). */
  sandbox: boolean
  /** Offer the built-in browser tools to project agents. */
  browserTool: boolean
  /** Offer the computer tool (screen + mouse + keyboard) to project agents. */
  computerUse: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  defaultModelId: null,
  defaultImageModelId: null,
  defaultThinking: 'off',
  sandbox: true,
  browserTool: true,
  computerUse: false,
}

/** OS permissions computer use depends on (macOS only; elsewhere always granted). */
export interface ComputerPermissions {
  supported: boolean
  accessibility: boolean
  screen: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
}

export interface RemoteDeviceDTO {
  deviceId: string
  name: string
  platform: string | null
  pairedAt: number
  lastSeen: number | null
  online: boolean
}

export type RemoteState =
  'disabled' | 'connecting' | 'online' | 'offline' | 'unauthorized' | 'error'

export interface RemoteStatusDTO {
  enabled: boolean
  relayUrl: string | null
  state: RemoteState
  detail?: string
  authMode?: 'open' | 'token' | 'upstream'
  hasToken: boolean
  /** Provider whose Base URL + Key authenticate to an "upstream" relay. */
  providerId: string | null
  deviceId: string
  deviceName: string
  devices: RemoteDeviceDTO[]
  pairing: { link: string; code: string; expiresAt: number } | null
  /** Phones that sent something in the last few minutes. */
  activeDevices: string[]
}

/** MCP server as shown in settings. Secret values come back masked as SECRET_MASK. */
export type McpServerDTO = McpServerConfig
export type { McpServerStatus }
export const SECRET_MASK = '••••••'

export interface PairRequestDTO {
  requestId: string
  name: string
  platform: string
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

  'projects.list': () => ProjectDTO[]
  /** Opens a folder picker; null if cancelled. */
  'projects.create': () => ProjectDTO | null
  'projects.update': (
    id: string,
    patch: {
      name?: string
      instructions?: string | null
      defaultModelId?: string | null
      permissionMode?: PermissionMode
    },
  ) => ProjectDTO
  /** Removes the project from the app; files on disk are untouched. */
  'projects.delete': (id: string) => void
  'projects.reveal': (id: string) => void

  'conversations.list': (opts?: { search?: string }) => ConversationDTO[]
  'conversations.get': (id: string) => ConversationDetail | null
  'conversations.create': (input?: {
    modelId?: string | null
    projectId?: string | null
  }) => ConversationDTO
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
  'chat.approve': (input: {
    conversationId: string
    toolCallId: string
    decision: ApprovalDecision
  }) => void
  'chat.approvals': () => ApprovalDTO[]
  /**
   * Undo the agent's file edits made after a user message (on the active
   * branch). With dryRun, only lists the files that would change.
   */
  'chat.rewindFiles': (input: {
    conversationId: string
    messageId: string
    dryRun?: boolean
  }) => { path: string; action: 'restore' | 'delete' }[]

  'remote.status': () => RemoteStatusDTO
  'remote.configure': (input: {
    enabled?: boolean
    relayUrl?: string | null
    token?: string | null
    providerId?: string | null
  }) => RemoteStatusDTO
  /** Look for a relay next to the configured providers ({base}/ctl/info). */
  'remote.detect': () => { relayUrl: string; auth: string } | null
  'remote.pair': () => { link: string; code: string; expiresAt: number }
  'remote.pairCancel': () => void
  'remote.pairRespond': (input: { requestId: string; accept: boolean }) => void
  'remote.revoke': (deviceId: string) => void

  'mcp.list': () => { servers: McpServerDTO[]; status: McpServerStatus[] }
  'mcp.save': (server: Omit<McpServerDTO, 'id'> & { id?: string }) => McpServerDTO
  'mcp.delete': (id: string) => void

  /** Open model-generated HTML in an isolated preview window. */
  'preview.html': (html: string) => void

  /** Bring the agent's built-in browser window to the front. */
  'browser.show': () => void
  'computer.permissions': () => ComputerPermissions
  /** Ask the OS for a permission (prompts, or opens System Settings). */
  'computer.requestPermission': (kind: 'accessibility' | 'screen') => ComputerPermissions

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

/**
 * Allowlist of callable methods. Typed as a record over every Rpc key, so
 * adding a method to Rpc without listing it here fails to compile.
 */
const RPC_ALLOWLIST: Record<RpcMethod, true> = {
  'app.info': true,
  'settings.get': true,
  'settings.set': true,
  'providers.list': true,
  'providers.create': true,
  'providers.update': true,
  'providers.delete': true,
  'providers.test': true,
  'providers.syncModels': true,
  'models.list': true,
  'models.available': true,
  'models.add': true,
  'models.update': true,
  'models.delete': true,
  'projects.list': true,
  'projects.create': true,
  'projects.update': true,
  'projects.delete': true,
  'projects.reveal': true,
  'conversations.list': true,
  'conversations.get': true,
  'conversations.create': true,
  'conversations.update': true,
  'conversations.delete': true,
  'chat.send': true,
  'chat.regenerate': true,
  'chat.edit': true,
  'chat.stop': true,
  'chat.switchBranch': true,
  'chat.running': true,
  'chat.approve': true,
  'chat.approvals': true,
  'chat.rewindFiles': true,
  'remote.status': true,
  'remote.configure': true,
  'remote.detect': true,
  'remote.pair': true,
  'remote.pairCancel': true,
  'remote.pairRespond': true,
  'remote.revoke': true,
  'mcp.list': true,
  'mcp.save': true,
  'mcp.delete': true,
  'preview.html': true,
  'browser.show': true,
  'computer.permissions': true,
  'computer.requestPermission': true,
  'blobs.put': true,
  'blobs.saveAs': true,
  'blobs.copyImage': true,
  'images.list': true,
  'images.generate': true,
  'images.delete': true,
  'data.export': true,
  'data.import': true,
}

export const RPC_METHODS = Object.keys(RPC_ALLOWLIST) as RpcMethod[]

/** Main → renderer push events. */
export type ChatStreamEvent =
  | { type: 'message'; conversationId: string; message: MessageDTO }
  | { type: 'delta'; conversationId: string; messageId: string; text?: string; reasoning?: string }
  | { type: 'done'; conversationId: string; message: MessageDTO }
  | { type: 'conversation'; conversation: ConversationDTO }
  /** A reply/agent run started or ended for this conversation. */
  | { type: 'run'; conversationId: string; running: boolean; error?: string }
  | { type: 'approval'; approval: ApprovalDTO }
  | { type: 'approval-resolved'; conversationId: string; toolCallId: string }

export interface Events {
  chat: ChatStreamEvent
  image: ImageJobDTO
  /** Something changed outside the current view (import, provider edits). */
  remote: RemoteStatusDTO
  'remote-pair': PairRequestDTO
  mcp: McpServerStatus[]
  invalidate: { scope: 'conversations' | 'providers' | 'models' | 'images' | 'projects' | 'all' }
}

export type EventName = keyof Events

export const EVENT_CHANNEL = (name: EventName) => `event:${name}`

/** Messages between main and the agent utilityProcess. */
export interface AgentRunRequest {
  provider: { baseUrl: string; apiKey: string; type: ProviderType }
  modelId: string
  protocol: Protocol | null
  messages: unknown[]
  temperature?: number
  maxOutputTokens?: number
  thinking: ThinkingLevel
  /** Plain chat: the conversation's own system prompt, no tools. */
  system?: string
  /** Present for project conversations: run as a coding agent. */
  agent?: {
    /** Background jobs (dev servers etc.) belong to the conversation. */
    conversationId: string
    cwd: string
    mode: PermissionMode
    projectName: string
    projectInstructions: string | null
    userSystemPrompt: string | null
    allowed: string[]
    /** Run bash commands in the OS sandbox, where supported. */
    sandbox: boolean
    /** Offer the built-in browser tools. */
    browser: boolean
    /** Offer the computer tool. */
    computer: boolean
    /** Set when the computer tool can't work yet, e.g. OS permissions are missing. */
    computerBlocked?: string
    imageModel?: {
      provider: { baseUrl: string; apiKey: string; type: ProviderType }
      modelId: string
    }
  }
}

export type AgentRequest =
  | { type: 'ping'; id: string }
  | { type: 'run.start'; runId: string; request: AgentRunRequest }
  | { type: 'run.abort'; runId: string }
  | { type: 'run.approve'; runId: string; toolCallId: string; decision: ApprovalDecision }
  | { type: 'mcp.configure'; servers: McpServerConfig[] }
  | { type: 'host.result'; id: string; result?: unknown; error?: string }
  /** Stop a conversation's background jobs (it was deleted). */
  | { type: 'jobs.clear'; conversationId: string }
  /** Stop all background jobs and exit (app is quitting). */
  | { type: 'shutdown' }

export type AgentResponse =
  | { type: 'pong'; id: string; pid: number }
  | { type: 'mcp.status'; servers: McpServerStatus[] }
  | { type: 'run.event'; runId: string; event: AgentEvent }
  | { type: 'run.approval'; runId: string; request: ApprovalRequest }
  /** The agent asks main to do something only main can, e.g. drive the browser window. */
  | { type: 'host.call'; id: string; method: string; params: unknown }
  | {
      type: 'run.end'
      runId: string
      status: 'done' | 'aborted' | 'error' | 'max-steps'
      error?: string
      /** Updated "always allow" keys for the conversation. */
      allowed: string[]
    }

export type { MessagePart }
