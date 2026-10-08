import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PermissionMode } from './permissions'

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.aitech/instructions.md']

/** Project instruction files the agent should always follow. */
export async function loadProjectInstructions(cwd: string): Promise<string> {
  const parts: string[] = []
  for (const name of INSTRUCTION_FILES) {
    try {
      const text = (await readFile(join(cwd, name), 'utf8')).trim()
      if (text) parts.push(`<file path="${name}">\n${text.slice(0, 20_000)}\n</file>`)
    } catch {
      // not present
    }
  }
  return parts.join('\n\n')
}

export function buildSystemPrompt(opts: {
  cwd: string
  platform: NodeJS.Platform
  shell: string
  mode: PermissionMode
  projectName?: string
  projectInstructions?: string
  fileInstructions?: string
  userSystemPrompt?: string
  now?: Date
}): string {
  const os = opts.platform === 'darwin' ? 'macOS' : opts.platform === 'win32' ? 'Windows' : 'Linux'
  const lines = [
    "You are aitech, an AI coding agent working on the user's computer through tools.",
    '',
    '# Environment',
    `- Operating system: ${os}`,
    `- Shell for the bash tool: ${opts.shell}`,
    `- Project root (working directory): ${opts.cwd}`,
    opts.projectName ? `- Project: ${opts.projectName}` : '',
    `- Current date: ${(opts.now ?? new Date()).toISOString().slice(0, 10)}`,
    '',
    '# How to work',
    '- Investigate before changing things: use list_files, grep and read_file to understand the code.',
    '- Read a file before editing it. Prefer edit_file for targeted changes; use write_file for new files.',
    '- Match the existing code style. Keep changes focused on what was asked.',
    '- After changes, run the relevant build, tests or linters with bash when the project has them, and fix what you broke.',
    '- For multi-step tasks, keep a short todo list with todo_write.',
    "- If the user denies a tool call, don't retry the same action; adjust or ask.",
    '- Never reveal or print secrets such as API keys found in files or the environment.',
    '- Be concise. Reply in the language the user writes in. When done, summarise what changed and how it was verified.',
  ]
  if (opts.mode === 'plan') {
    lines.push(
      '',
      '# Plan mode',
      'You are in plan mode: you can only read files and browse. Do not attempt to modify anything.',
      'Investigate, then present a clear, numbered implementation plan for the user to approve.',
    )
  }
  if (opts.fileInstructions)
    lines.push('', '# Project instructions (from files in the repository)', opts.fileInstructions)
  if (opts.projectInstructions?.trim())
    lines.push('', '# Project instructions (from the user)', opts.projectInstructions.trim())
  if (opts.userSystemPrompt?.trim())
    lines.push('', '# Additional instructions', opts.userSystemPrompt.trim())
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}
