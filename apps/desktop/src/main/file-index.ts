import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { IGNORED_DIRS } from '@aitech/agent/paths'

const run = promisify(execFile)
const MAX_FILES = 50_000
const TTL = 30_000

/**
 * Project file lists for @-mentions: `git ls-files` where possible (respects
 * .gitignore), else a walk that skips the usual build and dependency folders.
 */
export class FileIndex {
  private cache = new Map<string, { at: number; files: Promise<string[]> }>()

  async search(root: string, query: string, limit = 50): Promise<string[]> {
    return rank(await this.files(root), query, limit)
  }

  private files(root: string): Promise<string[]> {
    const hit = this.cache.get(root)
    if (hit && Date.now() - hit.at < TTL) return hit.files
    const files = listFiles(root).catch(() => [])
    this.cache.set(root, { at: Date.now(), files })
    return files
  }
}

async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await run(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
    )
    return withDirs(stdout.split('\n').filter(Boolean).slice(0, MAX_FILES))
  } catch {
    return withDirs(await walk(root))
  }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const stack = [root]
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(full)
      } else if (e.isFile()) out.push(relative(root, full).split('\\').join('/'))
    }
  }
  return out
}

/** Folders can be mentioned too: add each file's parent folders, with a trailing slash. */
function withDirs(files: string[]): string[] {
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  return [...dirs, ...files]
}

/** Best matches first: name prefix, name substring, path substring, then in-order letters. */
export function rank(files: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase()
  if (!q) return files.filter((f) => !f.slice(0, -1).includes('/')).slice(0, limit)
  const scored: { f: string; score: number }[] = []
  for (const f of files) {
    const lower = f.toLowerCase()
    const name = lower.replace(/\/$/, '').split('/').pop()!
    let score: number
    if (name.startsWith(q)) score = 0
    else if (name.includes(q)) score = 1
    else if (lower.includes(q)) score = 2
    else if (subsequence(lower, q)) score = 3
    else continue
    scored.push({ f, score: score * 1000 + f.length })
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((s) => s.f)
}

function subsequence(text: string, q: string): boolean {
  let i = 0
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true
  return false
}
