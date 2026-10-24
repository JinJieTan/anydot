import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  })
  return stdout
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const name = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return name === 'HEAD' ? null : name
  } catch {
    return null
  }
}

/** A new worktree at `path` on a new branch from the current HEAD of `root`. */
export async function addWorktree(root: string, path: string, branch: string): Promise<void> {
  // Forget worktrees whose folders are gone, so their branches count as free.
  await git(root, ['worktree', 'prune'])
  // A leftover branch of the same name (an earlier toggle) goes if it has nothing of its own.
  await git(root, ['branch', '-d', branch]).catch(() => {})
  await git(root, ['worktree', 'add', '-b', branch, path, 'HEAD'])
}

/**
 * Remove a worktree; refuses (throws) if it has uncommitted changes. The branch is
 * kept unless `deleteBranch`, and even then only if it has no unmerged commits.
 */
export async function removeWorktree(
  root: string,
  path: string,
  branch?: { deleteBranch: string },
): Promise<void> {
  await git(root, ['worktree', 'remove', path])
  if (branch) await git(root, ['branch', '-d', branch.deleteBranch]).catch(() => {})
}

export interface FileChange {
  path: string
  /** M modified, A added, D deleted, R renamed, ? untracked */
  status: 'M' | 'A' | 'D' | 'R' | '?'
  additions: number
  deletions: number
}

/** Uncommitted changes (staged, unstaged and untracked) against HEAD. */
export async function changes(cwd: string): Promise<FileChange[]> {
  const out = new Map<string, FileChange>()
  const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(
    () => true,
    () => false,
  )
  if (hasHead) {
    const status = await git(cwd, ['diff', 'HEAD', '--name-status', '-M', '-z'])
    const parts = status.split('\0').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i]![0] as string
      if (code === 'R' || code === 'C') {
        const to = parts[i + 2]!
        out.set(to, { path: to, status: 'R', additions: 0, deletions: 0 })
        i += 2
      } else {
        const path = parts[++i]!
        const s = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M'
        out.set(path, { path, status: s, additions: 0, deletions: 0 })
      }
    }
    const numstat = await git(cwd, ['diff', 'HEAD', '--numstat', '-M', '-z'])
    const fields = numstat.split('\0')
    for (let i = 0; i < fields.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(fields[i]!)
      if (!m) continue
      // Renames: "a\td\t" then old path and new path as separate fields.
      const path = m[3] || fields[(i += 2)]!
      const c = out.get(path)
      if (c) {
        c.additions = m[1] === '-' ? 0 : Number(m[1])
        c.deletions = m[2] === '-' ? 0 : Number(m[2])
      }
    }
  }
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  for (const path of untracked.split('\0').filter(Boolean)) {
    out.set(path, { path, status: '?', additions: await lineCount(join(cwd, path)), deletions: 0 })
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path))
}

async function lineCount(file: string): Promise<number> {
  try {
    if ((await stat(file)).size > 2 * 1024 * 1024) return 0
    const text = await readFile(file, 'utf8')
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
  } catch {
    return 0
  }
}

const MAX_DIFF = 400_000

/** Unified diff of one file against HEAD (untracked files show as all added). */
export async function fileDiff(cwd: string, path: string): Promise<string> {
  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', path]).then(
    () => true,
    () => false,
  )
  let diff: string
  if (tracked) {
    diff = await git(cwd, ['diff', 'HEAD', '-M', '--', path]).catch(() =>
      git(cwd, ['diff', '--', path]),
    )
  } else {
    // --no-index exits 1 when the files differ.
    diff = await exec('git', ['diff', '--no-index', '--', '/dev/null', path], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    }).then(
      (r) => r.stdout,
      (err: { stdout?: string }) => err.stdout ?? '',
    )
  }
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated)` : diff
}
