import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport as StdioTransport } from '@ai-sdk/mcp/mcp-stdio'
import { truncateOutput } from './shell'
import type { AgentTool } from './tools/types'

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpServerStatus {
  id: string
  name: string
  state: 'disabled' | 'connecting' | 'ready' | 'error'
  tools: string[]
  error?: string
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for every provider. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64)
}

interface Connection {
  config: McpServerConfig
  client: MCPClient | null
  tools: AgentTool<Record<string, unknown>>[]
  status: McpServerStatus
}

/**
 * Connections to the user's MCP servers. Their tools join the agent's tool
 * list and go through the same permission policy (kind "mcp").
 */
export class McpManager {
  private conns = new Map<string, Connection>()

  constructor(private readonly env: () => Promise<NodeJS.ProcessEnv>) {}

  /** Apply a new configuration: connect new/changed servers, drop removed ones. */
  async configure(configs: McpServerConfig[]): Promise<McpServerStatus[]> {
    const wanted = new Map(configs.map((c) => [c.id, c]))
    for (const [id, conn] of this.conns) {
      const next = wanted.get(id)
      if (!next || JSON.stringify(next) !== JSON.stringify(conn.config)) {
        await conn.client?.close().catch(() => {})
        this.conns.delete(id)
      }
    }
    await Promise.all(configs.filter((c) => !this.conns.has(c.id)).map((c) => this.connect(c)))
    return this.status()
  }

  status(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => c.status)
  }

  tools(): AgentTool<never>[] {
    return [...this.conns.values()].flatMap((c) => c.tools) as AgentTool<never>[]
  }

  async closeAll() {
    await Promise.all([...this.conns.values()].map((c) => c.client?.close().catch(() => {})))
    this.conns.clear()
  }

  private async connect(config: McpServerConfig) {
    const conn: Connection = {
      config,
      client: null,
      tools: [],
      status: {
        id: config.id,
        name: config.name,
        state: config.enabled ? 'connecting' : 'disabled',
        tools: [],
      },
    }
    this.conns.set(config.id, conn)
    if (!config.enabled) return

    try {
      let client: MCPClient
      if (config.transport === 'stdio') {
        if (!config.command) throw new Error('缺少启动命令')
        const env = await this.env()
        client = await createMCPClient({
          transport: new StdioTransport({
            command: config.command,
            args: config.args ?? [],
            env: { ...(env as Record<string, string>), ...(config.env ?? {}) },
            stderr: 'ignore',
          }),
        })
      } else {
        if (!config.url) throw new Error('缺少 URL')
        client = await createMCPClient({
          transport: { type: config.transport, url: config.url, headers: config.headers },
        })
      }
      conn.client = client
      const { tools } = await client.listTools()
      conn.tools = tools.map((t) => this.wrap(config, client, t))
      conn.status = {
        ...conn.status,
        state: 'ready',
        tools: conn.tools.map((t) => t.definition.name),
      }
    } catch (err) {
      conn.status = {
        ...conn.status,
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private wrap(
    server: McpServerConfig,
    client: MCPClient,
    tool: {
      name: string
      description?: string
      inputSchema: unknown
      annotations?: { readOnlyHint?: boolean }
    },
  ): AgentTool<Record<string, unknown>> {
    const name = mcpToolName(server.name, tool.name)
    return {
      // The server's own read-only hint lets harmless lookups skip confirmation.
      kind: tool.annotations?.readOnlyHint ? 'read' : 'mcp',
      definition: {
        name,
        description: `[MCP: ${server.name}] ${tool.description ?? tool.name}`.slice(0, 1024),
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
        },
      },
      describe: () => `${server.name} · ${tool.name}`,
      async run(input, ctx) {
        const res = await client.callTool({
          name: tool.name,
          arguments: input,
          options: { signal: ctx.signal },
        })
        const content = (res.content ?? []) as { type: string; text?: string; mimeType?: string }[]
        const text = content
          .map((c) =>
            c.type === 'text' ? (c.text ?? '') : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`,
          )
          .join('\n')
        return { output: truncateOutput(text || '(no output)'), isError: !!res.isError }
      },
    }
  }
}
