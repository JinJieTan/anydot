import clsx from 'clsx'
import { Plug, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { McpServerDTO, McpServerStatus } from '../../../shared/ipc'
import { api, invoke } from '../lib/api'
import { attempt, succeeded } from '../store/app'
import { Badge, Button, Field, Input, Modal, Select, Textarea, Toggle } from './ui'

const STATE: Record<
  McpServerStatus['state'],
  { text: string; tone: 'neutral' | 'accent' | 'warn' }
> = {
  disabled: { text: '已停用', tone: 'neutral' },
  connecting: { text: '连接中', tone: 'neutral' },
  ready: { text: '可用', tone: 'accent' },
  error: { text: '出错', tone: 'warn' },
}

/** "KEY=value" lines ⇄ record. */
const toLines = (r?: Record<string, string>, sep = '=') =>
  Object.entries(r ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')
const fromLines = (text: string, sep: RegExp) => {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = sep.exec(line.trim())
    if (m) out[m[1]!.trim()] = m[2]!.trim()
  }
  return Object.keys(out).length ? out : undefined
}

/** Split a command line into args, honouring simple quotes. */
function splitArgs(s: string): string[] {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'))
}

export function McpTab() {
  const [servers, setServers] = useState<McpServerDTO[]>([])
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [editing, setEditing] = useState<McpServerDTO | 'new' | null>(null)

  const reload = () =>
    void invoke('mcp.list').then((r) => {
      setServers(r.servers)
      setStatus(r.status)
    })
  useEffect(() => {
    reload()
    return api.on('mcp', setStatus)
  }, [])

  return (
    <div className="max-w-2xl space-y-5 p-6">
      <section>
        <div className="flex items-center">
          <h2 className="text-base font-semibold">MCP 工具</h2>
          <Button className="ml-auto" variant="primary" onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            添加
          </Button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          通过 Model Context Protocol 给项目里的 AI 接入更多工具，例如数据库、GitHub、浏览器。
          调用这些工具前会按项目的权限模式征求确认。
        </p>
      </section>

      <div className="overflow-hidden rounded-xl border border-line">
        {servers.map((s) => {
          const st = status.find((x) => x.id === s.id)
          const label = STATE[st?.state ?? (s.enabled ? 'connecting' : 'disabled')]
          return (
            <div key={s.id} className="border-b border-line px-4 py-3 last:border-b-0">
              <div className="flex items-center gap-3">
                <Plug className="size-4 text-fg-faint" />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setEditing(s)}
                >
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <div className="truncate font-mono text-xs text-fg-faint">
                    {s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url}
                  </div>
                </button>
                <Badge tone={label.tone}>{label.text}</Badge>
                <Toggle
                  checked={s.enabled}
                  label="启用"
                  onChange={async (enabled) => {
                    if (await attempt(() => invoke('mcp.save', { ...s, enabled }))) reload()
                  }}
                />
              </div>
              {st?.state === 'error' && (
                <div className="mt-1.5 pl-7 text-xs break-all text-red-600 dark:text-red-400">
                  {st.error}
                </div>
              )}
              {st?.state === 'ready' && (
                <div className="mt-1.5 flex flex-wrap gap-1 pl-7">
                  {st.tools.map((t) => (
                    <span
                      key={t}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-fg-soft"
                    >
                      {t.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {!servers.length && (
          <div className="px-4 py-8 text-center text-sm text-fg-faint">还没有添加 MCP 服务</div>
        )}
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '添加 MCP 服务' : '编辑 MCP 服务'}
      >
        {editing !== null && (
          <McpForm
            key={editing === 'new' ? 'new' : editing.id}
            server={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null)
              reload()
            }}
          />
        )}
      </Modal>
    </div>
  )
}

function McpForm({ server, onDone }: { server: McpServerDTO | null; onDone: () => void }) {
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<McpServerDTO['transport']>(
    server?.transport ?? 'stdio',
  )
  const [commandLine, setCommandLine] = useState(
    server ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') : '',
  )
  const [env, setEnv] = useState(toLines(server?.env))
  const [url, setUrl] = useState(server?.url ?? '')
  const [headers, setHeaders] = useState(toLines(server?.headers, ': '))
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    const [command, ...args] = splitArgs(commandLine)
    const ok = await attempt(() =>
      invoke('mcp.save', {
        id: server?.id,
        name,
        enabled: server?.enabled ?? true,
        transport,
        command: transport === 'stdio' ? command : undefined,
        args: transport === 'stdio' ? args : undefined,
        env: transport === 'stdio' ? fromLines(env, /^([^=]+)=(.*)$/) : undefined,
        url: transport !== 'stdio' ? url : undefined,
        headers: transport !== 'stdio' ? fromLines(headers, /^([^:]+):(.*)$/) : undefined,
      }),
    )
    setSaving(false)
    if (ok) onDone()
  }

  return (
    <>
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-[1fr_9rem] gap-3">
          <Field label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
          </Field>
          <Field label="连接方式">
            <Select
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpServerDTO['transport'])}
            >
              <option value="stdio">本地命令</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </Select>
          </Field>
        </div>
        {transport === 'stdio' ? (
          <>
            <Field
              label="启动命令"
              hint="例如 npx -y @modelcontextprotocol/server-filesystem ~/Documents"
            >
              <Input
                className="font-mono text-xs"
                value={commandLine}
                onChange={(e) => setCommandLine(e.target.value)}
              />
            </Field>
            <Field
              label="环境变量"
              hint="每行一个 KEY=value；已保存的值显示为 ••••••，不修改就保持原值"
            >
              <Textarea
                className="font-mono text-xs"
                rows={3}
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                placeholder="GITHUB_TOKEN=ghp_..."
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="地址">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
              />
            </Field>
            <Field label="请求头" hint="每行一个 Name: value">
              <Textarea
                className="font-mono text-xs"
                rows={3}
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                placeholder="Authorization: Bearer ..."
              />
            </Field>
          </>
        )}
      </div>
      <div
        className={clsx(
          'flex gap-2 border-t border-line px-5 py-3',
          server ? 'justify-between' : 'justify-end',
        )}
      >
        {server && (
          <Button
            variant="ghost"
            className="text-red-600 dark:text-red-400"
            onClick={async () => {
              if (
                window.confirm(`删除 MCP 服务「${server.name}」？`) &&
                (await succeeded(() => invoke('mcp.delete', server.id)))
              )
                onDone()
            }}
          >
            <Trash2 className="size-4" />
            删除
          </Button>
        )}
        <Button
          variant="primary"
          loading={saving}
          disabled={!name.trim()}
          onClick={() => void save()}
        >
          保存
        </Button>
      </div>
    </>
  )
}
