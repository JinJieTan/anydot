import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { McpManager, mcpToolName } from './mcp'
import { decide } from './permissions'
import type { AgentTool, ToolContext } from './tools/types'

const server = fileURLToPath(new URL('./testing-mcp-server.mjs', import.meta.url))
const ctx = { signal: new AbortController().signal } as ToolContext
let manager: McpManager

afterEach(() => manager?.closeAll())

describe('McpManager', () => {
  it('connects to a stdio server, lists and calls tools', async () => {
    manager = new McpManager(async () => process.env)
    const status = await manager.configure([
      {
        id: 's1',
        name: 'calc',
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [server],
        env: { MCP_TEST_VAR: 'hello' },
      },
    ])
    expect(status).toEqual([
      { id: 's1', name: 'calc', state: 'ready', tools: ['mcp__calc__add', 'mcp__calc__whoami'] },
    ])

    const [add, whoami] = manager.tools() as AgentTool<Record<string, unknown>>[]
    expect(await add!.run({ a: 2, b: 3 }, ctx)).toEqual({ output: '5', isError: false })
    expect(await whoami!.run({}, ctx)).toEqual({ output: 'hello', isError: false })

    // Permission policy: unknown MCP tools ask, read-only hinted ones don't.
    const p = { cwd: '/x', mode: 'ask' as const, allowed: new Set<string>() }
    expect(decide(add as AgentTool<never>, {}, p)).toMatchObject({ action: 'ask' })
    expect(decide(whoami as AgentTool<never>, {}, p)).toEqual({ action: 'allow' })
  })

  it('reports connection errors without throwing', async () => {
    manager = new McpManager(async () => process.env)
    const [st] = await manager.configure([
      {
        id: 's2',
        name: 'broken',
        enabled: true,
        transport: 'stdio',
        command: '/nonexistent/binary',
      },
    ])
    expect(st).toMatchObject({ state: 'error' })
    expect(manager.tools()).toHaveLength(0)
  })

  it('drops servers that are removed or disabled', async () => {
    manager = new McpManager(async () => process.env)
    const cfg = {
      id: 's1',
      name: 'calc',
      enabled: true,
      transport: 'stdio' as const,
      command: process.execPath,
      args: [server],
    }
    await manager.configure([cfg])
    expect(manager.tools()).toHaveLength(2)
    expect(await manager.configure([{ ...cfg, enabled: false }])).toEqual([
      { id: 's1', name: 'calc', state: 'disabled', tools: [] },
    ])
    expect(manager.tools()).toHaveLength(0)
  })

  it('sanitises tool names', () => {
    expect(mcpToolName('My Server!', 'get.file')).toBe('mcp__My_Server___get_file')
  })
})
