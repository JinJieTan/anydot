/**
 * IPC contract shared by main, preload and renderer.
 *
 * Every renderer → main call goes through `invoke(method, ...args)`; the
 * preload only forwards method names listed in RPC_METHODS. Keys never cross
 * into the renderer: providers expose `hasKey` / `keyHint` instead.
 */
import type {
  AgentEvent,
  DisplayInfo,
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
  ScheduleInput,
  ScheduleRow,
} from '@aitech/db'

export interface AppInfo {
  version: string
  platform: string
  versions: { electron: string; chrome: string; node: string }
  db: { path: string; schemaVersion: number }
  keyStorage: 'os' | 'plain'
  /** Folder with the app's log files. */
  logs: string
}

export interface UpdateStatusDTO {
  /**
   * unsupported: a dev build. available: a newer version to download by hand (macOS).
   * downloading → ready: Windows fetches it in the background, then restarts into it.
   */
  state:
    'unsupported' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'
  current: string
  version: string | null
  /** Download percent while downloading. */
  progress: number | null
  error: string | null
}

export interface FeedbackInput {
  message: string
  contact?: string
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
export type ScheduleDTO = ScheduleRow
export type { ScheduleInput }
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
  /** The experimental Windows sandbox (write restrictions only). */
  windowsSandbox: boolean
  /** Offer the built-in browser tools to project agents. */
  browserTool: boolean
  /** Where the browser tools run: the app's own window, or the user's Chrome via the extension. */
  browserBackend: 'builtin' | 'chrome'
  /** Offer the computer tool (screen + mouse + keyboard) to project agents. */
  computerUse: boolean
  /** Display the agent works on by default (driver id); null: the main display. */
  computerDisplay: string | null
  /** System notifications when a background run finishes or needs an approval. */
  notifications: boolean
  /** Run hooks from a project's own .claude/ or .aitech/ settings (user-level hooks always run). */
  projectHooks: boolean
  /** Show a tray / menu-bar icon. */
  trayIcon: boolean
  /** Global shortcut that brings up a new chat (Electron accelerator); empty: off. */
  globalShortcut: string
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  defaultModelId: null,
  defaultImageModelId: null,
  defaultThinking: 'off',
  sandbox: true,
  windowsSandbox: false,
  browserTool: true,
  browserBackend: 'builtin',
  computerUse: false,
  computerDisplay: null,
  notifications: true,
  projectHooks: false,
  trayIcon: true,
  globalShortcut: '',
}

export interface FileChangeDTO {
  path: string
  status: 'M' | 'A' | 'D' | 'R' | '?'
  additions: number
  deletions: number
}

/** A skill or custom slash command (SKILL.md / commands/*.md). */
export interface CommandDTO {
  kind: 'skill' | 'command'
  name: string
  description: string
  argumentHint?: string
  path: string
  scope: 'project' | 'user'
}

/** The AnyDot Chrome extension's connection to the app. */
export interface ChromeExtStatus {
  /** The app is listening for the extension (Chrome backend selected). */
  listening: boolean
  port: number | null
  connected: boolean
  /** Version of the connected extension. */
  extensionVersion: string | null
  userAgent: string | null
  /** Version of the extension this app ships. */
  expectedVersion: string
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

/** The relay run by AnyDot; used when no other relay is configured. */
export const OFFICIAL_RELAY_URL = 'https://anydot.app/ctl'

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
export type { DisplayInfo, McpServerStatus }
export const SECRET_MASK = '••••••'

export interface PairRequestDTO {
  requestId: string
  name: string
  platform: string
  /** Four digits the phone shows too; they match unless someone swapped keys in between. */
  check: string
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
  /** Record a renderer error in the log file. */
  'app.logError': (input: { message: string; stack?: string; source: string }) => void
  /** Open the log folder in the file manager. */
  'app.revealLogs': () => void

  'updates.status': () => UpdateStatusDTO
  'updates.check': () => UpdateStatusDTO
  /** Restart into a downloaded update, or open the download page. */
  'updates.install': () => void
  /** Sent to the AnyDot relay at anydot.app, read in its admin page. */
  'feedback.send': (input: FeedbackInput) => void

  'settings.get': () => Settings
  'settings.set': (patch: Partial<Settings>) => Settings
  /** A good global shortcut for this platform, offered on the settings page (the shortcut is off by default). */
  'settings.suggestedShortcut': () => string

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

  /**
   * Before the first message: run a project task in its own git worktree (on a
   * new branch), or go back to the project folder.
   */
  'conversations.setWorktree': (id: string, enabled: boolean) => ConversationDTO
  /** Uncommitted changes in the folder a conversation's agent works in. */
  'git.changes': (conversationId: string) => {
    repo: boolean
    branch: string | null
    folder: string
    files: FileChangeDTO[]
  }
  'git.diff': (input: { conversationId: string; path: string }) => string

  'schedules.list': () => ScheduleDTO[]
  'schedules.create': (input: ScheduleInput) => ScheduleDTO
  'schedules.update': (
    id: string,
    patch: Partial<ScheduleInput> & { enabled?: boolean },
  ) => ScheduleDTO
  'schedules.delete': (id: string) => void
  /** Run a scheduled task now; returns the new conversation's id. */
  'schedules.runNow': (id: string) => string
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
  /** Also deletes a plain chat's workspace folder. */
  'conversations.delete': (id: string) => void
  /** Opens a plain chat's workspace folder in the file manager. */
  'conversations.revealWorkspace': (id: string) => void

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
  /** Skills and slash commands for a conversation (null: just the user's own). */
  'chat.commands': (conversationId: string | null) => CommandDTO[]
  /** Project files matching a query, for @-mentions in the composer. */
  'chat.files': (input: { conversationId: string; query: string }) => string[]
  'chat.approve': (input: {
    conversationId: string
    toolCallId: string
    decision: ApprovalDecision
    /** For an ask_user approval: the answers, keyed by question. */
    answers?: Record<string, string>
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
  /** Serve a page for the artifact panel's sandboxed iframe; returns its URL. */
  'artifact.url': (html: string) => string
  /** Read a file the agent wrote (path relative to the conversation's folder), to show it as an artifact. */
  'artifact.readFile': (input: { conversationId: string; path: string }) => {
    path: string
    content: string
  }

  /** Bring the agent's built-in browser window to the front. */
  'browser.show': () => void
  'chromeExt.status': () => ChromeExtStatus
  /** Write the extension folder, reveal it and open chrome://extensions. */
  'chromeExt.install': () => { dir: string; chromeOpened: boolean }
  /** Save the extension as a zip. */
  'chromeExt.exportZip': () => { path: string } | null
  'computer.permissions': () => ComputerPermissions
  'computer.displays': () => DisplayInfo[]
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
  'app.logError': true,
  'app.revealLogs': true,
  'updates.status': true,
  'updates.check': true,
  'updates.install': true,
  'feedback.send': true,
  'settings.get': true,
  'settings.set': true,
  'settings.suggestedShortcut': true,
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
  'conversations.setWorktree': true,
  'git.changes': true,
  'git.diff': true,
  'schedules.list': true,
  'schedules.create': true,
  'schedules.update': true,
  'schedules.delete': true,
  'schedules.runNow': true,
  'projects.create': true,
  'projects.update': true,
  'projects.delete': true,
  'projects.reveal': true,
  'conversations.list': true,
  'conversations.get': true,
  'conversations.create': true,
  'conversations.update': true,
  'conversations.delete': true,
  'conversations.revealWorkspace': true,
  'chat.send': true,
  'chat.regenerate': true,
  'chat.edit': true,
  'chat.stop': true,
  'chat.switchBranch': true,
  'chat.running': true,
  'chat.commands': true,
  'chat.files': true,
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
  'artifact.url': true,
  'artifact.readFile': true,
  'browser.show': true,
  'chromeExt.status': true,
  'chromeExt.install': true,
  'chromeExt.exportZip': true,
  'computer.permissions': true,
  'computer.displays': true,
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
  'chrome-ext': ChromeExtStatus
  update: UpdateStatusDTO
  /** Bring a conversation to the front (e.g. a notification was clicked). */
  'open-conversation': { conversationId: string }
  /** From the tray or the global shortcut. */
  'app-command': { command: 'new-chat' | 'settings' }
  invalidate: {
    scope: 'conversations' | 'providers' | 'models' | 'images' | 'projects' | 'schedules' | 'all'
  }
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
  /** Plain chat without tools: the conversation's own system prompt. */
  system?: string
  /** Run as an agent with tools: in a project, or in a plain chat's own workspace folder. */
  agent?: {
    /** Background jobs (dev servers etc.) belong to the conversation. */
    conversationId: string
    cwd: string
    /** Plain chat: `cwd` is the conversation's workspace folder, not a project. */
    workspace?: boolean
    mode: PermissionMode
    projectName: string
    projectInstructions: string | null
    userSystemPrompt: string | null
    allowed: string[]
    /** Run bash commands in the OS sandbox, where supported. */
    sandbox: boolean
    /** Offer the built-in browser tools. */
    browser: boolean
    /** The browser tools drive the user's own Chrome (via the extension). */
    browserBackend?: 'builtin' | 'chrome'
    /** Offer the computer tool. */
    computer: boolean
    /** Set when the computer tool can't work yet, e.g. OS permissions are missing. */
    computerBlocked?: string
    /** Display to start on (null: main). */
    computerDisplay?: string | null
    /** Also run the project's own hooks. */
    projectHooks?: boolean
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
  /** The project's permission mode changed while the run was going. */
  | { type: 'run.mode'; runId: string; mode: PermissionMode }
  | {
      type: 'run.approve'
      runId: string
      toolCallId: string
      decision: ApprovalDecision
      /** Answers to an ask_user approval, keyed by question. */
      answers?: Record<string, string>
    }
  | { type: 'mcp.configure'; servers: McpServerConfig[] }
  | { type: 'host.result'; id: string; result?: unknown; error?: string }
  /** Stop a conversation's background jobs (it was deleted). */
  | { type: 'jobs.clear'; conversationId: string }
  /** Stop all background jobs and exit (app is quitting). */
  | { type: 'shutdown' }
  | { type: 'computer.displays'; id: string }

export type AgentResponse =
  | { type: 'pong'; id: string; pid: number }
  | { type: 'computer.displays'; id: string; displays?: DisplayInfo[]; error?: string }
  | { type: 'mcp.status'; servers: McpServerStatus[] }
  | { type: 'run.event'; runId: string; event: AgentEvent }
  | { type: 'run.approval'; runId: string; request: ApprovalRequest }
  /** A pending approval no longer needs the user (the mode changed and it now runs). */
  | { type: 'run.approval-resolved'; runId: string; toolCallId: string }
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
