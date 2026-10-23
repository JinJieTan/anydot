import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * Skills and slash commands, compatible with Claude Code's layout:
 *   skills:   <root>/skills/<name>/SKILL.md   (frontmatter: name, description)
 *   commands: <root>/commands/<name>.md       (frontmatter: description, argument-hint)
 * Roots, highest priority first: <project>/.aitech, <project>/.claude, ~/.aitech, ~/.claude.
 */
export interface Skill {
  kind: 'skill' | 'command'
  name: string
  description: string
  argumentHint?: string
  /** SKILL.md or the command file. */
  path: string
  scope: 'project' | 'user'
}

export function skillRoots(cwd: string | null, home = homedir()) {
  return [
    ...(cwd
      ? [
          { dir: join(cwd, '.aitech'), scope: 'project' as const },
          { dir: join(cwd, '.claude'), scope: 'project' as const },
        ]
      : []),
    { dir: join(home, '.aitech'), scope: 'user' as const },
    { dir: join(home, '.claude'), scope: 'user' as const },
  ]
}

/** Every skill and command visible from `cwd`; earlier roots shadow later ones by name. */
export async function loadSkills(cwd: string | null, home?: string): Promise<Skill[]> {
  const found = new Map<string, Skill>()
  const add = (s: Skill) => {
    const key = `${s.kind}:${s.name}`
    if (!found.has(key)) found.set(key, s)
  }
  for (const root of skillRoots(cwd, home)) {
    for (const entry of await list(join(root.dir, 'skills'))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(root.dir, 'skills', entry.name, 'SKILL.md')
      const text = await read(path)
      if (text === null) continue
      const { meta } = parseFrontmatter(text)
      add({
        kind: 'skill',
        name: meta['name'] || entry.name,
        description: meta['description'] || firstLine(text),
        path,
        scope: root.scope,
      })
    }
    for (const entry of await list(join(root.dir, 'commands'))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const path = join(root.dir, 'commands', entry.name)
      const text = await read(path)
      if (text === null) continue
      const { meta, body } = parseFrontmatter(text)
      add({
        kind: 'command',
        name: basename(entry.name, '.md'),
        description: meta['description'] || firstLine(body),
        argumentHint: meta['argument-hint'] || undefined,
        path,
        scope: root.scope,
      })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The full instructions of a skill, for the model. */
export async function readSkill(skill: Skill): Promise<string> {
  const { body } = parseFrontmatter(await readFile(skill.path, 'utf8'))
  return `Base directory for this skill: ${dirname(skill.path)}\n\n${body.trim()}`
}

/**
 * The prompt a slash command expands to. Commands substitute $ARGUMENTS
 * (or get the arguments appended); skills are loaded with the arguments as the task.
 */
export async function expandCommand(skill: Skill, args: string): Promise<string> {
  if (skill.kind === 'skill') {
    const body = await readSkill(skill)
    return `${body}${args.trim() ? `\n\nARGUMENTS: ${args.trim()}` : ''}`
  }
  const { body } = parseFrontmatter(await readFile(skill.path, 'utf8'))
  const text = body.trim()
  if (text.includes('$ARGUMENTS')) return text.replaceAll('$ARGUMENTS', args.trim())
  return args.trim() ? `${text}\n\nARGUMENTS: ${args.trim()}` : text
}

/** Minimal YAML frontmatter: `key: value` lines between --- fences. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return { meta, body: text.slice(m[0].length) }
}

function firstLine(text: string): string {
  const line = parseFrontmatter(text)
    .body.split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  return (line ?? '').slice(0, 200)
}

async function list(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
