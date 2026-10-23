import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasHooks, Hooks, loadHooks } from './hooks'

const posix = process.platform !== 'win32'

async function setup(projectHooks: object, userHooks: object) {
  const root = await mkdtemp(join(tmpdir(), 'aitech-hooks-'))
  const project = join(root, 'proj')
  const home = join(root, 'home')
  await mkdir(join(project, '.claude'), { recursive: true })
  await mkdir(join(home, '.aitech'), { recursive: true })
  await writeFile(join(project, '.claude/settings.json'), JSON.stringify({ hooks: projectHooks }))
  await writeFile(join(home, '.aitech/settings.json'), JSON.stringify({ hooks: userHooks }))
  return { project, home }
}

describe.runIf(posix)('hooks', () => {
  it('loads user hooks always and project hooks only when allowed', async () => {
    const cmd = (c: string) => [{ hooks: [{ type: 'command', command: c }] }]
    const { project, home } = await setup({ Stop: cmd('echo p') }, { PreToolUse: cmd('echo u') })
    const off = await loadHooks(project, { project: false }, home)
    expect(Object.keys(off)).toEqual(['PreToolUse'])
    const on = await loadHooks(project, { project: true }, home)
    expect(Object.keys(on).sort()).toEqual(['PreToolUse', 'Stop'])
    expect(hasHooks(await loadHooks(null, { project: true }, join(home, 'none')))).toBe(false)
  })

  it('blocks on exit 2, matches Claude tool names, passes JSON on stdin', async () => {
    const { project, home } = await setup(
      {},
      {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command:
                  'input=$(cat); case "$input" in *"rm -rf"*) echo "no rm" >&2; exit 2;; esac; exit 0',
              },
            ],
          },
          {
            matcher: 'Write|Edit',
            hooks: [
              {
                type: 'command',
                command:
                  'grep -q \'"file_path":"secret.txt"\' && echo \'{"decision":"block","reason":"protected"}\' || true',
              },
            ],
          },
        ],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'echo broken >&2; exit 1' }] }],
      },
    )
    const config = await loadHooks(project, { project: false }, home)
    const hooks = new Hooks(config, {
      cwd: project,
      env: process.env,
      platform: process.platform,
      sessionId: 's',
    })
    const bash = (command: string) =>
      hooks.run('PreToolUse', { tool_name: 'bash', tool_input: { command } })
    expect((await bash('rm -rf /tmp/x')).block).toBe('no rm')
    expect((await bash('ls')).block).toBeUndefined()
    const write = await hooks.run('PreToolUse', {
      tool_name: 'write_file',
      tool_input: { path: 'secret.txt', content: '' },
    })
    expect(write.block).toBe('protected')
    // Matchers are anchored: "Bash" doesn't match bash_output.
    expect(
      (await hooks.run('PreToolUse', { tool_name: 'bash_output', tool_input: {} })).block,
    ).toBeUndefined()
    const post = await hooks.run('PostToolUse', { tool_name: 'read_file', tool_input: {} })
    expect(post.block).toBeUndefined()
    expect(post.notes[0]).toMatch(/broken/)
  })
})
