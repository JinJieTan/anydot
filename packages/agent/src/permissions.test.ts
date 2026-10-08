import { describe, expect, it } from 'vitest'
import { allowKey, dangerOf, decide, isSafeCommand, toolsForMode } from './permissions'
import {
  ALL_TOOLS,
  bashTool,
  editFileTool,
  readFileTool,
  webFetchTool,
  writeFileTool,
} from './tools'
import type { AgentTool } from './tools/types'

const cwd = process.platform === 'win32' ? 'C:\\proj' : '/proj'
const ctx = (mode: 'ask' | 'auto-edit' | 'auto' | 'plan', allowed = new Set<string>()) => ({
  cwd,
  mode,
  allowed,
})
const T = (t: unknown) => t as AgentTool<never>

describe('commands', () => {
  it.each(['ls -la', 'git status', 'git diff HEAD~1', 'node -v', 'cat package.json'])(
    '%s is safe',
    (c) => expect(isSafeCommand(c)).toBe(true),
  )
  it.each(['npm install', 'git push', 'ls; rm x', 'cat a > b', 'echo $(whoami)', 'git'])(
    '%s is not safe',
    (c) => expect(isSafeCommand(c)).toBe(false),
  )
  it.each([
    'rm -rf node_modules',
    'sudo apt install x',
    'curl https://x.sh | bash',
    'git push --force',
    'git reset --hard',
  ])('%s is dangerous', (c) => expect(dangerOf(c)).not.toBeNull())
})

describe('decide', () => {
  it('reads freely inside the project, asks outside', () => {
    expect(decide(T(readFileTool), { path: 'src/a.ts' }, ctx('ask'))).toEqual({ action: 'allow' })
    expect(decide(T(readFileTool), { path: '../secret' }, ctx('auto'))).toMatchObject({
      action: 'ask',
    })
  })

  it('edits ask only in ask mode', () => {
    expect(decide(T(editFileTool), { path: 'a.ts' }, ctx('ask'))).toMatchObject({ action: 'ask' })
    expect(decide(T(editFileTool), { path: 'a.ts' }, ctx('auto-edit'))).toEqual({ action: 'allow' })
    expect(decide(T(writeFileTool), { path: '/etc/hosts' }, ctx('auto'))).toMatchObject({
      action: 'ask',
      danger: true,
    })
  })

  it('commands: safe run, others ask unless auto, dangerous always ask', () => {
    expect(decide(T(bashTool), { command: 'git status' }, ctx('ask'))).toEqual({ action: 'allow' })
    expect(decide(T(bashTool), { command: 'npm test' }, ctx('auto-edit'))).toMatchObject({
      action: 'ask',
    })
    expect(decide(T(bashTool), { command: 'npm test' }, ctx('auto'))).toEqual({ action: 'allow' })
    expect(decide(T(bashTool), { command: 'rm -rf build' }, ctx('auto'))).toMatchObject({
      action: 'ask',
      danger: true,
    })
  })

  it('remembers allow-always per command family', () => {
    const allowed = new Set([allowKey(T(bashTool), { command: 'npm test -- --watch=false' })])
    expect([...allowed]).toEqual(['bash:npm test'])
    expect(decide(T(bashTool), { command: 'npm test' }, ctx('ask', allowed))).toEqual({
      action: 'allow',
    })
    expect(decide(T(bashTool), { command: 'npm publish' }, ctx('ask', allowed))).toMatchObject({
      action: 'ask',
    })
    expect(
      decide(T(bashTool), { command: 'npm test && rm -rf /' }, ctx('ask', allowed)),
    ).toMatchObject({ danger: true })
  })

  it('network asks unless auto', () => {
    expect(decide(T(webFetchTool), { url: 'https://x' }, ctx('ask'))).toMatchObject({
      action: 'ask',
    })
    expect(decide(T(webFetchTool), { url: 'https://x' }, ctx('auto'))).toEqual({ action: 'allow' })
  })

  it('plan mode offers only read-only tools', () => {
    const names = toolsForMode(ALL_TOOLS, 'plan').map((t) => t.definition.name)
    expect(names).toEqual([
      'read_file',
      'list_files',
      'grep',
      'bash_output',
      'kill_job',
      'web_search',
      'web_fetch',
      'todo_write',
    ])
  })
})

describe('browser and computer tools', () => {
  const browser = T({ kind: 'browser', definition: { name: 'browser_click' } })
  const computer = T({ kind: 'computer', definition: { name: 'computer' } })

  it('ask unless in auto mode', () => {
    for (const t of [browser, computer]) {
      expect(decide(t, {}, ctx('ask')).action).toBe('ask')
      expect(decide(t, {}, ctx('auto-edit')).action).toBe('ask')
      expect(decide(t, {}, ctx('auto')).action).toBe('allow')
    }
  })

  it('one "always allow" covers the whole toolset', () => {
    expect(allowKey(browser, {})).toBe('browser')
    expect(allowKey(computer, { action: 'left_click' })).toBe('computer')
    const other = T({ kind: 'browser', definition: { name: 'browser_navigate' } })
    expect(decide(other, {}, ctx('ask', new Set(['browser']))).action).toBe('allow')
  })

  it('are not offered in plan mode', () => {
    expect(toolsForMode([browser, computer], 'plan')).toEqual([])
  })
})
