import type { ProviderCredentials, ToolDefinition } from '@aitech/core'

/**
 * What a tool does, which drives the permission policy:
 * read    – inspects files, no side effects
 * write   – creates or modifies files
 * exec    – runs arbitrary commands
 * network – talks to the internet
 * image   – calls a paid image model and writes files
 * meta    – bookkeeping only (todo list)
 * mcp     – provided by an external MCP server; effects unknown
 */
export type ToolKind = 'read' | 'write' | 'exec' | 'network' | 'image' | 'meta' | 'mcp'

export interface ToolResult {
  output: string
  isError?: boolean
}

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
