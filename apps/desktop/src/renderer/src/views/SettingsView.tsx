import clsx from 'clsx'
import { CheckCircle2, Download, Plus, RefreshCw, Trash2, Upload, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Capability, Protocol, ProviderType } from '@aitech/core'
import type { AppInfo, ModelDTO, ProviderDTO, Rpc, Settings, TestResult } from '../../../shared/ipc'
import { modelLabel } from '../components/ModelPicker'
import { AutomationTab } from '../components/Automation'
import { McpTab } from '../components/Mcp'
import { RemoteTab } from '../components/Remote'
import { SchedulesTab } from '../components/Schedules'
import { UpdateCheck } from '../components/Updates'
import { Badge, Button, Field, IconButton, Input, Select, Spinner, Toggle } from '../components/ui'
import { invoke, isMac } from '../lib/api'
import { attempt, succeeded, useApp } from '../store/app'

type Tab =
  'providers' | 'mcp' | 'automation' | 'schedules' | 'remote' | 'general' | 'data' | 'about'

const TABS: { id: Tab; label: string }[] = [
  { id: 'providers', label: '服务商与模型' },
  { id: 'mcp', label: 'MCP 工具' },
  { id: 'automation', label: 'Agent 能力' },
  { id: 'schedules', label: '定时任务' },
  { id: 'remote', label: '手机连接' },
  { id: 'general', label: '通用' },
  { id: 'data', label: '数据' },
  { id: 'about', label: '关于' },
]

export function SettingsView() {
  const [tab, setTab] = useState<Tab>('providers')
  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-12 shrink-0 items-center border-b border-line px-4">
        <h1 className="text-sm font-medium">设置</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="w-44 shrink-0 space-y-0.5 border-r border-line p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={clsx(
                'flex h-8 w-full items-center rounded-lg px-3 text-sm',
                tab === t.id
                  ? 'bg-muted font-medium'
                  : 'text-fg-soft hover:bg-muted/70 hover:text-fg',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {tab === 'providers' && <ProvidersTab />}
          {tab === 'mcp' && <McpTab />}
          {tab === 'automation' && <AutomationTab />}
          {tab === 'schedules' && <SchedulesTab />}
          {tab === 'remote' && <RemoteTab />}
          {tab === 'general' && <GeneralTab />}
          {tab === 'data' && <DataTab />}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </div>
  )
}

// ── providers ────────────────────────────────────────────────

const TYPE_LABEL: Record<ProviderType, string> = {
  auto: '自动识别（推荐）',
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
}

function ProvidersTab() {
  const { providers } = useApp()
  const [picked, setSelected] = useState<string | 'new' | null>(null)
  // Fall back to the first provider (or the "new" form) when nothing valid is picked.
  const selected =
    picked === 'new' || providers.some((p) => p.id === picked)
      ? picked
      : (providers[0]?.id ?? 'new')

  const current = providers.find((p) => p.id === selected)

  return (
    <div className="flex h-full">
      <div className="w-56 shrink-0 space-y-0.5 border-r border-line p-2">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelected(p.id)}
            className={clsx(
              'flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm',
              selected === p.id
                ? 'bg-accent/10 font-medium text-accent'
                : 'text-fg-soft hover:bg-muted/70',
            )}
          >
            <span
              title={p.enabled ? '已启用' : '已停用'}
              className={clsx(
                'size-1.5 shrink-0 rounded-full',
                p.enabled ? 'bg-emerald-500' : 'bg-line-strong',
              )}
            />
            <span className="truncate">{p.name}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSelected('new')}
          className={clsx(
            'flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm',
            selected === 'new'
              ? 'bg-accent/10 font-medium text-accent'
              : 'text-fg-soft hover:bg-muted/70',
          )}
        >
          <Plus className="size-4" />
          添加服务商
        </button>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {selected === 'new' ? (
          <ProviderForm key="new" onSaved={(p) => setSelected(p.id)} />
        ) : current ? (
          <div className="max-w-2xl space-y-8">
            <ProviderForm key={current.id} provider={current} onSaved={() => {}} />
            <ModelList provider={current} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ProviderForm({
  provider,
  onSaved,
}: {
  provider?: ProviderDTO
  onSaved: (p: ProviderDTO) => void
}) {
  const { notify } = useApp()
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [type, setType] = useState<ProviderType>(provider?.type ?? 'auto')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<TestResult | null>(null)

  const dirty =
    !provider ||
    name !== provider.name ||
    baseUrl !== provider.baseUrl ||
    type !== provider.type ||
    apiKey !== ''

  const save = async () => {
    setSaving(true)
    const input = {
      name: name.trim() || hostOf(baseUrl),
      baseUrl,
      type,
      apiKey: apiKey || undefined,
    }
    const saved = await attempt(() =>
      provider ? invoke('providers.update', provider.id, input) : invoke('providers.create', input),
    )
    if (saved) {
      setApiKey('')
      // A new provider is only useful with models; fetch them right away.
      if (!provider) {
        const res = await attempt(() => invoke('providers.syncModels', saved.id))
        notify(res ? `已添加，获取到 ${res.total} 个模型` : '已添加，但获取模型失败，可稍后重试')
      } else {
        notify('已保存')
      }
      onSaved(saved)
    }
    setSaving(false)
  }

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    const res = await attempt(() =>
      invoke('providers.test', { id: provider?.id, baseUrl, apiKey: apiKey || undefined, type }),
    )
    setTest(res ?? { ok: false, error: '测试失败' })
    setTesting(false)
  }

  return (
    <section className="max-w-2xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">{provider ? provider.name : '添加服务商'}</h2>
        {provider && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-fg-soft">启用</span>
            <Toggle
              checked={provider.enabled}
              label="启用服务商"
              onChange={(enabled) =>
                void attempt(() => invoke('providers.update', provider.id, { enabled }))
              }
            />
          </div>
        )}
      </div>
      <div className="space-y-4">
        <Field
          label="Base URL"
          hint="填写到域名即可，例如 https://api.example.com（/v1 可加可不加）"
        >
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com"
          />
        </Field>
        <Field
          label="API Key"
          hint={
            provider?.hasKey
              ? `已保存（${provider.keyHint}），留空表示不修改。Key 使用系统钥匙串加密保存在本机。`
              : 'Key 使用系统钥匙串加密保存在本机，不会上传。'
          }
        >
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider?.hasKey ? '••••••••（不修改）' : 'sk-...'}
            autoComplete="off"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={hostOf(baseUrl) || '我的中转站'}
            />
          </Field>
          <Field label="协议">
            <Select value={type} onChange={(e) => setType(e.target.value as ProviderType)}>
              {(Object.keys(TYPE_LABEL) as ProviderType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="text-xs leading-relaxed text-fg-faint">
          自动识别：claude-* 走 Anthropic 接口（/v1/messages），gpt-image-* 走生图接口，其余走
          OpenAI Responses 接口。 如果你的服务只支持 Chat
          Completions，可以在下方模型列表里单独指定。
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            loading={saving}
            disabled={!dirty || !baseUrl.trim()}
            onClick={() => void save()}
          >
            {provider ? '保存' : '添加并获取模型'}
          </Button>
          <Button loading={testing} disabled={!baseUrl.trim()} onClick={() => void runTest()}>
            测试连接
          </Button>
          {test &&
            (test.ok ? (
              <span className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-4" />
                连接成功，{test.models} 个模型
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1 text-sm text-red-600 dark:text-red-400">
                <XCircle className="size-4 shrink-0" />
                <span className="truncate" title={test.error}>
                  {test.error}
                </span>
              </span>
            ))}
          {provider && (
            <Button
              variant="ghost"
              className="ml-auto text-red-600 dark:text-red-400"
              onClick={async () => {
                if (!window.confirm(`删除服务商「${provider.name}」及其模型？已有对话不会被删除。`))
                  return
                await attempt(() => invoke('providers.delete', provider.id))
              }}
            >
              <Trash2 className="size-4" />
              删除
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url.trim()).hostname
  } catch {
    return ''
  }
}

const CAP_LABEL: Record<Capability, string> = {
  chat: '对话',
  vision: '识图',
  reasoning: '思考',
  image: '生图',
  video: '视频',
}

const PROTOCOL_OPTIONS: { value: '' | Protocol; label: string }[] = [
  { value: '', label: '自动' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-chat', label: 'OpenAI Chat' },
  { value: 'openai-images', label: '生图' },
]

function ModelList({ provider }: { provider: ProviderDTO }) {
  const { notify } = useApp()
  const [models, setModels] = useState<ModelDTO[] | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [filter, setFilter] = useState('')
  const [newModel, setNewModel] = useState('')

  const reload = () => void invoke('models.list', provider.id).then(setModels)
  useEffect(reload, [provider.id])

  const visible = useMemo(
    () =>
      (models ?? []).filter((m) => m.modelId.toLowerCase().includes(filter.trim().toLowerCase())),
    [models, filter],
  )
  const allEnabled = visible.length > 0 && visible.every((m) => m.enabled)

  const patch = async (m: ModelDTO, p: Parameters<Rpc['models.update']>[1]) => {
    const next = await attempt(() => invoke('models.update', m.id, p))
    if (next) setModels((list) => list?.map((x) => (x.id === m.id ? next : x)) ?? null)
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold">模型</h3>
        <span className="text-xs text-fg-faint">
          {models ? `${models.filter((m) => m.enabled).length} / ${models.length} 已启用` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            className="h-8 w-44"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选"
          />
          <Button
            size="sm"
            loading={syncing}
            onClick={async () => {
              setSyncing(true)
              const res = await attempt(() => invoke('providers.syncModels', provider.id))
              setSyncing(false)
              if (res) {
                notify(res.added ? `新增 ${res.added} 个模型` : '模型列表已是最新')
                reload()
              }
            }}
          >
            <RefreshCw className="size-3.5" />
            获取模型
          </Button>
        </div>
      </div>

      {models === null ? (
        <Spinner />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          {visible.length > 0 && (
            <div className="flex items-center gap-3 border-b border-line bg-muted/40 px-3 py-2 text-xs text-fg-soft">
              <Toggle
                checked={allEnabled}
                label="全部启用/停用"
                onChange={async (enabled) => {
                  for (const m of visible) if (m.enabled !== enabled) await patch(m, { enabled })
                }}
              />
              <span>{filter ? '筛选结果' : '全部'}</span>
              <span className="ml-auto w-40">协议</span>
              <span className="w-8" />
            </div>
          )}
          <div className="max-h-[420px] overflow-y-auto">
            {visible.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
              >
                <Toggle
                  checked={m.enabled}
                  label="启用"
                  onChange={(enabled) => void patch(m, { enabled })}
                />
                <div className="min-w-0 flex-1">
                  <div className={clsx('truncate text-sm', !m.enabled && 'text-fg-faint')}>
                    {modelLabel(m)}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {(['chat', 'vision', 'reasoning', 'image'] as Capability[]).map((c) => {
                      const on = m.capabilities.includes(c)
                      return (
                        <button
                          key={c}
                          type="button"
                          title={on ? `取消「${CAP_LABEL[c]}」` : `标记为支持「${CAP_LABEL[c]}」`}
                          onClick={() =>
                            void patch(m, {
                              capabilities: on
                                ? m.capabilities.filter((x) => x !== c)
                                : [...m.capabilities, c],
                            })
                          }
                        >
                          <span className={clsx(!on && 'opacity-35')}>
                            <Badge tone={on ? 'accent' : 'neutral'}>{CAP_LABEL[c]}</Badge>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <Select
                  className="h-8 w-40 shrink-0 text-xs"
                  value={m.protocol ?? ''}
                  onChange={(e) =>
                    void patch(m, { protocol: (e.target.value || null) as Protocol | null })
                  }
                >
                  {PROTOCOL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <IconButton
                  label="删除模型"
                  onClick={async () => {
                    const ok = await succeeded(() => invoke('models.delete', m.id))
                    if (ok) setModels((list) => list?.filter((x) => x.id !== m.id) ?? null)
                  }}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
            {visible.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-fg-faint">
                {models.length
                  ? '没有匹配的模型'
                  : '还没有模型，点「获取模型」从服务商拉取，或在下方手动添加'}
              </div>
            )}
          </div>
          <form
            className="flex items-center gap-2 border-t border-line bg-muted/30 px-3 py-2"
            onSubmit={async (e) => {
              e.preventDefault()
              const added = await attempt(() =>
                invoke('models.add', { providerId: provider.id, modelId: newModel }),
              )
              if (added) {
                setNewModel('')
                reload()
              }
            }}
          >
            <Input
              className="h-8"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              placeholder="手动添加模型 ID，例如 gpt-image-2"
            />
            <Button size="sm" type="submit" disabled={!newModel.trim()}>
              添加
            </Button>
          </form>
        </div>
      )}
    </section>
  )
}

// ── general ──────────────────────────────────────────────────

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Return',
}

/** Electron accelerator for a key press, or null while only modifiers are down. */
function accelerator(e: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null
  const code = e.code
  const key = code.startsWith('Key')
    ? code.slice(3)
    : code.startsWith('Digit')
      ? code.slice(5)
      : /^F\d+$/.test(code)
        ? code
        : (KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : null))
  if (!key) return null
  const mods = [
    e.metaKey && (isMac ? 'Command' : 'Super'),
    e.ctrlKey && 'Control',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
  ].filter(Boolean)
  // A bare key would fire while typing anywhere.
  if (!mods.length && !/^F\d+$/.test(key)) return null
  return [...mods, key].join('+')
}

const pretty = (acc: string) =>
  isMac
    ? acc
        .replace('Command', '⌘')
        .replace('Control', '⌃')
        .replace('Alt', '⌥')
        .replace('Shift', '⇧')
        .replace(/\+/g, ' ')
    : acc

function ShortcutInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return
          e.preventDefault()
          if (e.key === 'Escape') return setRecording(false)
          const acc = accelerator(e.nativeEvent)
          if (acc) {
            setRecording(false)
            onChange(acc)
          }
        }}
        className={clsx(
          'h-9 min-w-40 rounded-lg border px-3 text-left font-mono text-sm',
          recording ? 'border-accent text-fg-soft' : 'border-line',
        )}
      >
        {recording ? '按下快捷键…' : value ? pretty(value) : '未设置'}
      </button>
      {value && (
        <Button size="sm" variant="ghost" onClick={() => onChange('')}>
          关闭
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void invoke('settings.suggestedShortcut').then(onChange)}
      >
        使用推荐
      </Button>
    </div>
  )
}

function GeneralTab() {
  const { settings, updateSettings, models } = useApp()
  const chatModels = models.filter((m) => m.capabilities.includes('chat'))
  const imageModels = models.filter((m) => m.capabilities.includes('image'))
  const set = (patch: Partial<Settings>) => void updateSettings(patch)

  return (
    <div className="max-w-xl space-y-5 p-6">
      <Field label="外观">
        <Select
          value={settings.theme}
          onChange={(e) => set({ theme: e.target.value as Settings['theme'] })}
        >
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </Select>
      </Field>
      <Field
        label="全局快捷键"
        hint="默认关闭。开启后在任何应用中按下即可打开 AnyDot 并新建对话，AnyDot 在前台时再按一次会隐藏"
      >
        <ShortcutInput
          value={settings.globalShortcut}
          onChange={(globalShortcut) => void succeeded(() => updateSettings({ globalShortcut }))}
        />
      </Field>
      <Field
        label={isMac ? '菜单栏图标' : '托盘图标'}
        hint={
          isMac
            ? '在菜单栏显示图标，可以快速新建对话'
            : '在托盘显示图标；开启时关闭窗口后 AnyDot 继续在后台运行（定时任务、手机连接）'
        }
      >
        <Toggle
          checked={settings.trayIcon}
          label="显示图标"
          onChange={(trayIcon) => void succeeded(() => updateSettings({ trayIcon }))}
        />
      </Field>
      <Field label="系统通知" hint="窗口不在前台时，任务完成、出错或需要确认会弹出系统通知">
        <Toggle
          checked={settings.notifications}
          label="开启系统通知"
          onChange={(notifications) => set({ notifications })}
        />
      </Field>
      <Field label="默认对话模型" hint="新对话默认使用的模型">
        <Select
          value={settings.defaultModelId ?? ''}
          onChange={(e) => set({ defaultModelId: e.target.value || null })}
        >
          <option value="">第一个可用模型</option>
          {chatModels.map((m) => (
            <option key={m.id} value={m.id}>
              {modelLabel(m)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="默认生图模型">
        <Select
          value={settings.defaultImageModelId ?? ''}
          onChange={(e) => set({ defaultImageModelId: e.target.value || null })}
        >
          <option value="">第一个可用模型</option>
          {imageModels.map((m) => (
            <option key={m.id} value={m.id}>
              {modelLabel(m)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="默认思考强度" hint="仅对支持思考的模型生效（Claude、GPT-5 等）">
        <Select
          value={settings.defaultThinking}
          onChange={(e) => set({ defaultThinking: e.target.value as Settings['defaultThinking'] })}
        >
          <option value="off">关闭</option>
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </Select>
      </Field>
    </div>
  )
}

// ── data ─────────────────────────────────────────────────────

function DataTab() {
  const { notify } = useApp()
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => void invoke('app.info').then(setInfo), [])

  return (
    <div className="max-w-xl space-y-6 p-6">
      <section>
        <h2 className="text-sm font-semibold">备份与迁移</h2>
        <p className="mt-1 text-sm leading-relaxed text-fg-soft">
          所有对话和图片只保存在本机。导出的 zip 包含对话、生图记录和图片，可以在另一台电脑上导入。
          出于安全考虑，API Key 不会被导出，导入后需要重新填写。
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            loading={busy === 'export'}
            onClick={async () => {
              setBusy('export')
              const res = await attempt(() => invoke('data.export'))
              setBusy(null)
              if (res) notify(`已导出到 ${res.path}`)
            }}
          >
            <Download className="size-4" />
            导出数据
          </Button>
          <Button
            loading={busy === 'import'}
            onClick={async () => {
              setBusy('import')
              const res = await attempt(() => invoke('data.import'))
              setBusy(null)
              if (res)
                notify(
                  `已导入 ${res.conversations} 个对话、${res.messages} 条消息、${res.imageJobs} 条生图记录`,
                )
            }}
          >
            <Upload className="size-4" />
            导入数据
          </Button>
        </div>
      </section>
      {info && (
        <section>
          <h2 className="text-sm font-semibold">存储位置</h2>
          <p className="mt-1 font-mono text-xs break-all text-fg-soft">{info.db.path}</p>
        </section>
      )}
    </div>
  )
}

// ── about ────────────────────────────────────────────────────

function AboutTab() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => void invoke('app.info').then(setInfo), [])
  if (!info)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    )
  const rows: [string, string][] = [
    ['版本', info.version],
    ['平台', info.platform],
    ['Electron', info.versions.electron],
    ['Node', info.versions.node],
    ['数据库', `schema v${info.db.schemaVersion}`],
    ['Key 存储', info.keyStorage === 'os' ? '系统钥匙串加密' : '未加密（系统不支持钥匙串）'],
    ['日志', info.logs],
  ]
  return (
    <div className="max-w-xl p-6">
      <h2 className="text-base font-semibold">AnyDot</h2>
      <p className="mt-1 text-sm text-fg-soft">
        开源 AI 桌面客户端：填入 Base URL 和 Key，使用 GPT、Claude 与 gpt-image。
      </p>
      <dl className="mt-5 grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-soft">{k}</dt>
            <dd className="min-w-0 break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5">
        <UpdateCheck />
      </div>
      <div className="mt-3">
        <Button size="sm" onClick={() => void invoke('app.revealLogs')}>
          打开日志文件夹
        </Button>
      </div>
    </div>
  )
}
