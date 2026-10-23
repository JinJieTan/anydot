import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shellFor } from './shell'

/**
 * Hooks: shell commands run around agent events, in Claude Code's format
 * (the "hooks" key of settings.json):
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "bash|Edit", "hooks": [
 *       { "type": "command", "command": "./check.sh", "timeout": 60 } ] } ] } }
 *
 * The event is sent as JSON on stdin. Exit code 2 blocks: PreToolUse skips the
 * call, PostToolUse feeds stderr back to the model, Stop makes the agent keep
 * going with stderr as the reason. A JSON stdout of {"decision":"block","reason"}
 * does the same. Other non-zero exits are reported but don't block.
 */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop'

interface HookCommand {
  command: string
  timeout: number
}

interface HookGroup {
  matcher: RegExp | null
  hooks: HookCommand[]
}

export type HookConfig = Partial<Record<HookEvent, HookGroup[]>>

/** Claude Code's names for our tools, so its matchers and scripts keep working. */
const CLAUDE_NAMES: Record<string, string> = {
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  list_files: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  todo_write: 'TodoWrite',
  task: 'Task',
  ask_user: 'AskUserQuestion',
}

const EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop']

export function hookFiles(cwd: string | null, opts: { project: boolean }, home = homedir()) {
  return [
    join(home, '.claude', 'settings.json'),
    join(home, '.aitech', 'settings.json'),
    ...(cwd && opts.project
      ? [
          join(cwd, '.claude', 'settings.json'),
          join(cwd, '.claude', 'settings.local.json'),
          join(cwd, '.aitech', 'settings.json'),
        ]
      : []),
  ]
}

/** Hooks from every settings file, in order (user first, then project when allowed). */
export async function loadHooks(
  cwd: string | null,
  opts: { project: boolean },
  home?: string,
): Promise<HookConfig> {
  const out: HookConfig = {}
  for (const file of hookFiles(cwd, opts, home)) {
    let json: unknown
    try {
      json = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      continue
    }
    const hooks = (json as { hooks?: Record<string, unknown> } | null)?.hooks
    if (!hooks || typeof hooks !== 'object') continue
    for (const event of EVENTS) {
      const groups = hooks[event]
      if (!Array.isArray(groups)) continue
      for (const g of groups as { matcher?: unknown; hooks?: unknown }[]) {
        const commands = (Array.isArray(g?.hooks) ? g.hooks : [])
          .filter(
            (h: { type?: unknown; command?: unknown }) =>
              h?.type === 'command' && typeof h.command === 'string' && h.command.trim(),
          )
          .map((h: { command: string; timeout?: unknown }) => ({
            command: h.command,
            timeout: typeof h.timeout === 'number' && h.timeout > 0 ? h.timeout : 60,
          }))
        if (!commands.length) continue
        let matcher: RegExp | null = null
        if (typeof g.matcher === 'string' && g.matcher && g.matcher !== '*') {
          try {
            matcher = new RegExp(`^(?:${g.matcher})$`)
          } catch {
            continue
          }
        }
        ;(out[event] ??= []).push({ matcher, hooks: commands })
      }
    }
  }
  return out
}

export function hasHooks(config: HookConfig): boolean {
  return EVENTS.some((e) => config[e]?.length)
}

export interface HookOutcome {
  /** Set when a hook blocked: why, for the model. */
  block?: string
  /** Messages from hooks that failed without blocking. */
  notes: string[]
}

export class Hooks {
  constructor(
    private readonly config: HookConfig,
    private readonly ctx: {
      cwd: string
      env: NodeJS.ProcessEnv
      platform: NodeJS.Platform
      sessionId: string
    },
  ) {}

  /** Run the hooks for an event (tool events: only groups whose matcher fits the tool). */
  async run(
    event: HookEvent,
    payload: { tool_name?: string; tool_input?: unknown; tool_response?: unknown } & Record<
      string,
      unknown
    >,
    signal?: AbortSignal,
  ): Promise<HookOutcome> {
    const groups = this.config[event] ?? []
    const tool = payload.tool_name
    const names = tool ? [tool, CLAUDE_NAMES[tool]].filter(Boolean) : []
    const matching = groups.filter(
      (g) => !g.matcher || !tool || names.some((n) => g.matcher!.test(n!)),
    )
    const outcome: HookOutcome = { notes: [] }
    if (!matching.length) return outcome
    const input = JSON.stringify({
      session_id: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      hook_event_name: event,
      ...payload,
      ...(tool ? { tool_input: withAliases(payload.tool_input) } : {}),
    })
    for (const g of matching)
      for (const h of g.hooks) {
        const r = await runHook(h, input, this.ctx, signal)
        const decided = parseDecision(r.stdout)
        if (r.code === 2 || decided?.block) {
          outcome.block =
            (decided?.reason || r.stderr || r.stdout).trim() || `Blocked by hook: ${h.command}`
          return outcome
        }
        if (r.code !== 0)
          outcome.notes.push(
            `Hook "${h.command}" failed (${r.code ?? 'timeout'}): ${r.stderr.trim()}`,
          )
      }
    return outcome
  }
}

/** Claude Code scripts read tool_input.file_path; ours says path. */
function withAliases(input: unknown): unknown {
  if (input && typeof input === 'object' && 'path' in input && !('file_path' in input))
    return { ...input, file_path: (input as { path: unknown }).path }
  return input
}

function parseDecision(stdout: string): { block: boolean; reason?: string } | null {
  const text = stdout.trim()
  if (!text.startsWith('{')) return null
  try {
    const j = JSON.parse(text) as { decision?: string; reason?: string; continue?: boolean }
    if (j.decision === 'block' || j.continue === false) return { block: true, reason: j.reason }
  } catch {
    // not JSON
  }
  return null
}

function runHook(
  h: HookCommand,
  input: string,
  ctx: { cwd: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform },
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const { shell, args } = shellFor(ctx.platform, ctx.env)
    const child = spawn(shell, [...args, h.command], {
      cwd: ctx.cwd,
      env: { ...ctx.env, CLAUDE_PROJECT_DIR: ctx.cwd, AITECH_PROJECT_DIR: ctx.cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const cap = (s: string, chunk: Buffer) => (s.length < 100_000 ? s + chunk.toString() : s)
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)))
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)))
    const timer = setTimeout(() => child.kill('SIGKILL'), h.timeout * 1000)
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code: 1, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
