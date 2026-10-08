import type { McpServerConfig, McpServerStatus } from '@aitech/agent'
import { newId } from '@aitech/core'
import type { Store } from '@aitech/db'
import { SECRET_MASK, type McpServerDTO } from '../shared/ipc'
import type { AgentHost } from './agent-host'
import { decryptKey, encryptKey } from './secrets'

const KEY = 'mcp.servers'

/**
 * MCP server configuration. Stored encrypted (env vars and headers often hold
 * API keys) and pushed to the agent process, which owns the connections.
 */
export class McpService {
  private status: McpServerStatus[] = []

  constructor(
    private readonly store: Store,
    private readonly agent: AgentHost,
    private readonly emit: (status: McpServerStatus[]) => void,
  ) {
    agent.onStart = () => this.push()
    agent.onMcpStatus = (s) => {
      this.status = s
      this.emit(s)
    }
  }

  private load(): McpServerConfig[] {
    const ref = this.store.getSetting<string | null>(KEY, null)
    if (!ref) return []
    try {
      return JSON.parse(decryptKey(ref) ?? '[]') as McpServerConfig[]
    } catch {
      return []
    }
  }

  private save(list: McpServerConfig[]) {
    this.store.setSetting(KEY, encryptKey(JSON.stringify(list)))
    this.push()
  }

  push() {
    this.agent.configureMcp(this.load())
  }

  list(): { servers: McpServerDTO[]; status: McpServerStatus[] } {
    const mask = (r?: Record<string, string>) =>
      r && Object.fromEntries(Object.keys(r).map((k) => [k, SECRET_MASK]))
    return {
      servers: this.load().map((s) => ({ ...s, env: mask(s.env), headers: mask(s.headers) })),
      status: this.status,
    }
  }

  upsert(input: Omit<McpServerDTO, 'id'> & { id?: string }): McpServerDTO {
    const name = input.name.trim()
    if (!/^[\w\- .一-龥]{1,40}$/.test(name))
      throw new Error('名称只能包含字母、数字、中文、空格、- 和 _，最多 40 个字符')
    if (input.transport === 'stdio' && !input.command?.trim()) throw new Error('请填写启动命令')
    if (input.transport !== 'stdio' && !/^https?:\/\//.test(input.url ?? ''))
      throw new Error('请填写 http(s) 地址')

    const list = this.load()
    const prev = input.id ? list.find((s) => s.id === input.id) : undefined
    // Masked values mean "unchanged".
    const unmask = (next?: Record<string, string>, old?: Record<string, string>) =>
      next &&
      Object.fromEntries(
        Object.entries(next).map(([k, v]) => [k, v === SECRET_MASK ? (old?.[k] ?? '') : v]),
      )
    if (list.some((s) => s.id !== prev?.id && s.name === name))
      throw new Error('已存在同名的 MCP 服务')

    const server: McpServerConfig = {
      id: prev?.id ?? newId(),
      name,
      enabled: input.enabled,
      transport: input.transport,
      command: input.command?.trim(),
      args: input.args,
      env: unmask(input.env, prev?.env),
      url: input.url?.trim(),
      headers: unmask(input.headers, prev?.headers),
    }
    this.save(prev ? list.map((s) => (s.id === prev.id ? server : s)) : [...list, server])
    return this.list().servers.find((s) => s.id === server.id)!
  }

  remove(id: string) {
    this.save(this.load().filter((s) => s.id !== id))
  }
}
