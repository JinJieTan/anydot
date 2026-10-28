import { dirname } from 'node:path'
import { resolvePath } from './paths'
import type { AgentTool, ToolKind } from './tools/types'

/**
 * ask       – confirm every change and every non-trivial command (default)
 * auto-edit – file edits inside the project run freely; commands still ask
 * auto      – everything runs freely except dangerous commands and paths outside the project
 * plan      – read-only: only investigation tools are offered
 */
export type PermissionMode = 'ask' | 'auto-edit' | 'auto' | 'plan'

export type Decision =
  | { action: 'allow' }
  | {
      action: 'ask'
      reason: string
      danger: boolean
      /** Keys "always allow" remembers; defaults to allowKey(tool, input). */
      remember?: string[]
    }

const PLAN_KINDS: ToolKind[] = ['read', 'meta', 'network']

/** Tools offered to the model in a given mode. */
export function toolsForMode<T extends AgentTool<never>>(tools: T[], mode: PermissionMode): T[] {
  return mode === 'plan' ? tools.filter((t) => PLAN_KINDS.includes(t.kind)) : tools
}

const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b/i, '递归删除文件'],
  [/\bsudo\b|\bdoas\b/, '使用管理员权限'],
  [
    /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python|node)\b/i,
    '下载并直接执行脚本',
  ],
  [/\bgit\s+push\b.*(--force|-f\b)/, '强制推送'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, '丢弃本地改动'],
  [/\b(mkfs|fdisk|diskutil\s+erase|format\s+[a-z]:)/i, '格式化磁盘'],
  [/\bdd\s+.*\bof=/, '直接写入设备'],
  [/\b(shutdown|reboot|halt)\b/, '关机或重启'],
  [/\bchmod\s+(-R\s+)?777\b/, '放开全部权限'],
  [/>\s*\/dev\/(sd|disk|nvme)/, '写入磁盘设备'],
  [/\bRemove-Item\b.*-Recurse/i, '递归删除文件'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, '发布软件包'],
  [/:\(\)\s*\{.*\};\s*:/, 'fork 炸弹'],
]

/** Single read-only commands that never need confirmation. */
const SAFE_COMMANDS = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'which',
  'whoami',
  'date',
  'uname',
  'tree',
  'file',
  'stat',
  'du',
  'df',
  'env',
  'printenv',
  'sort',
  'uniq',
  'diff',
  'grep',
  'rg',
  'Get-ChildItem',
  'Get-Content',
  'Get-Location',
  'dir',
  'type',
])
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    'status',
    'diff',
    'log',
    'show',
    'branch',
    'remote',
    'rev-parse',
    'ls-files',
    'blame',
    'tag',
  ]),
  npm: new Set(['ls', 'list', 'view', 'outdated', '-v', '--version']),
  pnpm: new Set(['ls', 'list', 'outdated', '-v', '--version']),
  node: new Set(['-v', '--version']),
  python: new Set(['--version', '-V']),
  python3: new Set(['--version', '-V']),
  go: new Set(['version', 'env']),
  cargo: new Set(['--version']),
}

export function dangerOf(command: string): string | null {
  for (const [re, label] of DANGEROUS) if (re.test(command)) return label
  return null
}

/** True for a single, side-effect-free command with no shell plumbing. */
export function isSafeCommand(command: string): boolean {
  const c = command.trim()
  if (!c || /[;&|><`$(){}]|\n/.test(c)) return false
  const [cmd, sub] = c.split(/\s+/)
  if (!cmd) return false
  if (SAFE_COMMANDS.has(cmd)) return true
  return !!sub && !!SAFE_SUBCOMMANDS[cmd]?.has(sub)
}

/** Key used for "always allow in this session". */
export function allowKey(tool: AgentTool<never>, input: Record<string, unknown>): string {
  if (tool.kind === 'exec') {
    // Approve a command family, e.g. "npm test" or "pnpm build", not every command.
    const words = String(input.command ?? '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
    // Running outside the sandbox is approved separately from the same command inside it.
    const prefix = input.unsandboxed ? `${tool.definition.name}!` : tool.definition.name
    return `${prefix}:${words.join(' ')}`
  }
  // One approval covers the whole browser / computer toolset for the session.
  if (tool.kind === 'browser' || tool.kind === 'computer') return tool.kind
  return tool.definition.name
}

/** Key that approves reading (or writing) anywhere under `dir`, outside the project. */
function dirKey(access: 'read' | 'write', dir: string): string {
  return `${access}@${dir}`
}

/** True when an earlier "always allow" covers this outside path; a write approval covers reads too. */
function outsideAllowed(allowed: Set<string>, abs: string, access: 'read' | 'write'): boolean {
  for (const key of allowed) {
    const at = key.indexOf('@')
    if (at < 0) continue
    const scope = key.slice(0, at)
    if (scope !== 'write' && scope !== access) continue
    if (resolvePath(key.slice(at + 1), abs).inside) return true
  }
  return false
}

export function decide(
  tool: AgentTool<never>,
  input: Record<string, unknown>,
  ctx: { cwd: string; mode: PermissionMode; allowed: Set<string>; sandboxed?: boolean },
): Decision {
  const t = tool as AgentTool<Record<string, unknown>>

  // The mode can switch to plan mid-run, after the full toolset was offered.
  if (ctx.mode === 'plan' && !PLAN_KINDS.includes(tool.kind)) {
    return { action: 'ask', reason: '当前是只读规划模式', danger: false }
  }

  const access = tool.kind === 'write' || tool.kind === 'image' ? 'write' : 'read'
  const outside = (t.paths?.(input) ?? [])
    .map((p) => resolvePath(ctx.cwd, p))
    .filter((r) => !r.inside)
  const pending = outside.filter((r) => !outsideAllowed(ctx.allowed, r.abs, access))
  if (pending.length) {
    return {
      action: 'ask',
      reason: `访问项目目录以外的路径：${pending.map((r) => r.abs).join(', ')}`,
      danger: false,
      // "Always allow" approves the folder, not just this one file.
      remember: pending.map((r) => dirKey(access, dirname(r.abs))),
    }
  }
  // Reading or writing a folder the user already approved needs nothing more.
  if (outside.length && (tool.kind === 'read' || tool.kind === 'write')) return { action: 'allow' }

  if (tool.kind === 'exec') {
    const command = String(input.command ?? '')
    const danger = dangerOf(command)
    // Dangerous commands always ask, even in auto mode or after "always allow".
    if (danger) return { action: 'ask', reason: `可能有风险的命令：${danger}`, danger: true }
    // Leaving the sandbox always asks, even in auto mode.
    if (ctx.sandboxed && input.unsandboxed) {
      return ctx.allowed.has(allowKey(tool, input))
        ? { action: 'allow' }
        : { action: 'ask', reason: '在沙箱外运行命令（不受目录限制）', danger: false }
    }
    if (isSafeCommand(command)) return { action: 'allow' }
    if (ctx.mode === 'auto' || ctx.allowed.has(allowKey(tool, input))) return { action: 'allow' }
    return { action: 'ask', reason: '运行命令', danger: false }
  }

  if (tool.kind === 'read' || tool.kind === 'meta') return { action: 'allow' }
  if (ctx.allowed.has(allowKey(tool, input))) return { action: 'allow' }

  switch (tool.kind) {
    case 'write':
      return ctx.mode === 'ask'
        ? { action: 'ask', reason: '修改文件', danger: false }
        : { action: 'allow' }
    case 'network':
      return ctx.mode === 'auto'
        ? { action: 'allow' }
        : { action: 'ask', reason: '访问网络', danger: false }
    case 'image':
      return ctx.mode === 'auto'
        ? { action: 'allow' }
        : { action: 'ask', reason: '调用生图模型（会产生费用）', danger: false }
    case 'browser':
      return ctx.mode === 'auto'
        ? { action: 'allow' }
        : { action: 'ask', reason: '操作内置浏览器', danger: false }
    case 'computer':
      return ctx.mode === 'auto'
        ? { action: 'allow' }
        : { action: 'ask', reason: '查看屏幕并控制鼠标键盘', danger: false }
  }
  return { action: 'ask', reason: '执行操作', danger: false }
}
