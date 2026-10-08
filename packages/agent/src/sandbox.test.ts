import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { allowKey, decide } from './permissions'
import { sandboxAvailable, seatbeltProfile } from './sandbox'
import { runCommand } from './shell'
import { bashTool } from './tools'
import type { AgentTool } from './tools/types'

const bash = bashTool as unknown as AgentTool<never>
const ctx = (mode: 'ask' | 'auto', sandboxed: boolean, allowed = new Set<string>()) => ({
  cwd: '/proj',
  mode,
  allowed,
  sandboxed,
})

describe('sandbox permissions', () => {
  it('leaving the sandbox always asks, even in auto mode', () => {
    const input = { command: 'npm install', unsandboxed: true }
    expect(decide(bash, input, ctx('auto', true))).toMatchObject({ action: 'ask' })
    expect(decide(bash, { command: 'npm install' }, ctx('auto', true)).action).toBe('allow')
    // Without a sandbox the flag means nothing.
    expect(decide(bash, input, ctx('auto', false)).action).toBe('allow')
  })

  it('remembers unsandboxed approvals separately', () => {
    const out = allowKey(bash, { command: 'npm install x', unsandboxed: true })
    expect(out).toBe('bash!:npm install')
    expect(allowKey(bash, { command: 'npm install x' })).toBe('bash:npm install')
    const input = { command: 'npm install y', unsandboxed: true }
    expect(decide(bash, input, ctx('auto', true, new Set([out]))).action).toBe('allow')
  })

  it('quotes paths in the profile', () => {
    const p = seatbeltProfile({ cwd: '/a "b"\\c', home: '/h' })
    expect(p).toContain('(subpath "/a \\"b\\"\\\\c")')
    expect(p).toContain('(subpath "/h/.ssh")')
  })
})

describe.runIf(process.platform === 'darwin' && sandboxAvailable())('macOS sandbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitech-sbx-'))
  const home = mkdtempSync(join(tmpdir(), 'aitech-home-'))
  mkdirSync(join(home, '.ssh'))
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret')
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
  // A "home" outside the writable temp dirs, so writing there must fail.
  const outside = join(process.env.HOME ?? '/Users/Shared', `.aitech-sbx-${process.pid}`)
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(outside, { force: true })
  })

  const run = (command: string) =>
    runCommand(command, {
      cwd: dir,
      env: { ...process.env, HOME: home },
      platform: 'darwin',
      timeoutMs: 20_000,
      signal: new AbortController().signal,
      sandbox: true,
    })

  it('writes inside the project and temp dirs', async () => {
    const r = await run(
      `echo hi > a.txt && echo ok > "${join(tmpdir(), 'aitech-sbx-ok')}" && cat a.txt`,
    )
    expect(r.exitCode).toBe(0)
    expect(r.output.trim()).toBe('hi')
  })

  it('cannot write elsewhere, read credentials or plant git hooks', async () => {
    const w = await run(`echo x > "${outside}"`)
    expect(w.exitCode).not.toBe(0)
    expect(existsSync(outside)).toBe(false)
    const r = await run(`cat "${home}/.ssh/id_rsa"`)
    expect(r.exitCode).not.toBe(0)
    expect(r.output).not.toContain('secret')
    const h = await run('echo evil > .git/hooks/pre-commit')
    expect(h.exitCode).not.toBe(0)
  })
})

describe.runIf(process.platform === 'win32' && sandboxAvailable())('Windows sandbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitech-sbx-'))
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), '[core]\n')
  // Under the user profile but outside every writable directory.
  const outside = join(
    process.env.USERPROFILE ?? 'C:\\Users\\Public',
    `aitech-sbx-${process.pid}.txt`,
  )
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { force: true })
  })

  const run = (command: string) =>
    runCommand(command, {
      cwd: dir,
      env: process.env,
      platform: 'win32',
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      sandbox: true,
    })

  it('writes inside the project and temp dir and runs node', async () => {
    const r = await run(
      `Set-Content -Path a.txt -Value hi; Set-Content -Path "${join(tmpdir(), 'aitech-sbx-ok.txt')}" -Value ok; node -e "require('fs').writeFileSync('b.txt','x'); console.log('node ok')"; Get-Content a.txt`,
    )
    expect(r.output).toContain('node ok')
    expect(r.output).toContain('hi')
    expect(r.exitCode).toBe(0)
  }, 60_000)

  it('cannot write elsewhere or plant git hooks', async () => {
    const w = await run(`Set-Content -Path "${outside}" -Value x`)
    expect(existsSync(outside)).toBe(false)
    expect(w.output).toMatch(/denied|UnauthorizedAccess/i)
    await run('Set-Content -Path .git\\hooks\\pre-commit -Value evil')
    expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false)
    await run('Add-Content -Path .git\\config -Value evil')
    expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toContain('evil')
  }, 60_000)
})
