import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addWorktree, changes, currentBranch, fileDiff, isRepo, removeWorktree } from './git'

let root: string
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'aitech-git-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 't@example.com')
  sh(root, 'config', 'user.name', 'T')
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(root, 'b.txt'), 'bee\n')
  sh(root, 'add', '.')
  sh(root, 'commit', '-q', '-m', 'init')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('git', () => {
  it('lists changes and diffs against HEAD', async () => {
    expect(await isRepo(root)).toBe(true)
    expect(await isRepo(tmpdir())).toBe(false)
    expect(await currentBranch(root)).toBe('main')
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\n')
    rmSync(join(root, 'b.txt'))
    writeFileSync(join(root, 'new.txt'), 'x\ny\n')
    expect(await changes(root)).toEqual([
      { path: 'a.txt', status: 'M', additions: 2, deletions: 1 },
      { path: 'b.txt', status: 'D', additions: 0, deletions: 1 },
      { path: 'new.txt', status: '?', additions: 2, deletions: 0 },
    ])
    expect(await fileDiff(root, 'a.txt')).toContain('+TWO')
    expect(await fileDiff(root, 'new.txt')).toContain('+y')
    sh(root, 'checkout', '-q', '--', '.')
    rmSync(join(root, 'new.txt'))
    expect(await changes(root)).toEqual([])
  })

  it('creates and removes worktrees on their own branch', async () => {
    const wt = join(mkdtempSync(join(tmpdir(), 'aitech-wt-')), 'w')
    await addWorktree(root, wt, 'aitech/test')
    expect(await currentBranch(wt)).toBe('aitech/test')
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    await expect(removeWorktree(root, wt)).rejects.toThrow()
    sh(wt, 'checkout', '-q', '--', '.')
    await removeWorktree(root, wt)
    expect(sh(root, 'branch', '--list', 'aitech/test').toString()).toContain('aitech/test')
  })
})
