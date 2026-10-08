import type { ProviderCredentials, ToolDefinition, ToolImage } from '@aitech/core'
import type { Computer } from '../computer'
import type { JobScope } from '../jobs'

/**
 * What a tool does, which drives the permission policy:
 * read    – inspects files, no side effects
 * write   – creates or modifies files
 * exec    – runs arbitrary commands
 * network – talks to the internet
 * image   – calls a paid image model and writes files
 * meta    – bookkeeping only (todo list)
 * mcp     – provided by an external MCP server; effects unknown
 * browser – drives the built-in browser window (can submit forms, log in…)
 * computer – sees the screen and controls the real mouse and keyboard
 */
export type ToolKind =
  'read' | 'write' | 'exec' | 'network' | 'image' | 'meta' | 'mcp' | 'browser' | 'computer'

export interface ToolResult {
  output: string
  isError?: boolean
  /** Screenshots for the model to look at. */
  images?: ToolImage[]
  /** Files as they were before this call changed them, so the change can be undone. */
  backups?: FileBackup[]
}

export interface FileBackup {
  /** Absolute path. */
  path: string
  /** Previous content, or null if the file didn't exist (undo deletes it). */
  data: Uint8Array | null
}

/** Calls into the desktop app, e.g. to drive its built-in browser window. */
export type HostCall = (method: string, params: unknown) => Promise<unknown>

export interface ToolContext {
  /** Project root; relative paths resolve against it. */
  cwd: string
  signal: AbortSignal
  platform: NodeJS.Platform
  /** Environment for spawned commands (login-shell PATH etc). */
  env: NodeJS.ProcessEnv
  /** Files the agent has read in this run, with mtime at read time. */
  readFiles: Map<string, number>
  imageModel?: { provider: ProviderCredentials; modelId: string }
  host?: HostCall
  /** Present when computer use is enabled and supported on this OS. */
  computer?: Computer
  /** Why the computer can't be used right now (e.g. missing OS permissions). */
  computerBlocked?: string
  /** Commands run in the OS sandbox unless the model asks (and the user approves) otherwise. */
  sandbox?: boolean
  /** Background jobs of this conversation; absent where they aren't supported. */
  jobs?: JobScope
}

export interface AgentTool<I = Record<string, unknown>> {
  kind: ToolKind
  definition: ToolDefinition
  /** Short human summary for approval prompts and UI, e.g. "运行 npm test". */
  describe(input: I): string
  /** Paths this call touches, for the outside-project check. */
  paths?(input: I): string[]
  run(input: I, ctx: ToolContext): Promise<ToolResult>
}

export function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw new ToolInputError(`"${field}" must be a non-empty string`)
  return v
}

export class ToolInputError extends Error {}
