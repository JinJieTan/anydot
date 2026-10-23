import clsx from 'clsx'
import { AlarmClock, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ScheduleDTO, ScheduleInput } from '../../../shared/ipc'
import { api, invoke } from '../lib/api'
import { attempt, succeeded, useApp } from '../store/app'
import { modelLabel } from './ModelPicker'
import {
  Badge,
  Button,
  confirmDialog,
  Field,
  IconButton,
  Input,
  Modal,
  Select,
  Textarea,
  Toggle,
} from './ui'

type Freq = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

interface Timing {
  freq: Freq
  minute: number
  hour: number
  weekday: number
  custom: string
}

function toCron(t: Timing): string {
  switch (t.freq) {
    case 'hourly':
      return `${t.minute} * * * *`
    case 'daily':
      return `${t.minute} ${t.hour} * * *`
    case 'weekdays':
      return `${t.minute} ${t.hour} * * 1-5`
    case 'weekly':
      return `${t.minute} ${t.hour} * * ${t.weekday}`
    case 'custom':
      return t.custom
  }
}

function fromCron(cron: string): Timing {
  const base = { minute: 0, hour: 9, weekday: 1, custom: cron }
  const p = cron.split(' ')
  const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null)
  const [m, h, dom, mon, dow] = p
  const minute = num(m)
  const hour = num(h)
  if (p.length === 5 && minute !== null && dom === '*' && mon === '*') {
    if (h === '*' && dow === '*') return { ...base, freq: 'hourly', minute }
    if (hour !== null) {
      if (dow === '*') return { ...base, freq: 'daily', minute, hour }
      if (dow === '1-5') return { ...base, freq: 'weekdays', minute, hour }
      const d = num(dow)
      if (d !== null && d <= 6) return { ...base, freq: 'weekly', minute, hour, weekday: d }
    }
  }
  return { ...base, freq: 'custom' }
}

const pad = (n: number) => String(n).padStart(2, '0')

export function describeCron(cron: string): string {
  const t = fromCron(cron)
  const time = `${pad(t.hour)}:${pad(t.minute)}`
  switch (t.freq) {
    case 'hourly':
      return `每小时第 ${t.minute} 分`
    case 'daily':
      return `每天 ${time}`
    case 'weekdays':
      return `工作日 ${time}`
    case 'weekly':
      return `每周${WEEKDAYS[t.weekday]} ${time}`
    case 'custom':
      return `cron: ${cron}`
  }
}

const fmt = (t: number | null) =>
  t === null
    ? '—'
    : new Date(t).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })

export function SchedulesTab() {
  const [list, setList] = useState<ScheduleDTO[]>([])
  const [editing, setEditing] = useState<ScheduleDTO | 'new' | null>(null)
  const projects = useApp((s) => s.projects)

  useEffect(() => {
    const load = () => void invoke('schedules.list').then(setList)
    load()
    return api.on('invalidate', ({ scope }) => {
      if (scope === 'schedules' || scope === 'all') load()
    })
  }, [])

  const runNow = async (s: ScheduleDTO) => {
    const id = await attempt(() => invoke('schedules.runNow', s.id))
    if (id) {
      await useApp.getState().loadConversations()
      useApp.getState().open(id)
    }
  }

  return (
    <div className="max-w-3xl space-y-4 p-6">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h2 className="text-base font-semibold">定时任务</h2>
          <p className="mt-1 text-sm leading-relaxed text-fg-soft">
            到点后自动新建一个对话并发送任务，可以放在项目里（按项目的权限模式运行）或作为普通对话。
            应用需要保持运行；关闭期间错过的任务会在下次启动时补跑一次。需要确认的操作会弹出系统通知。
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="size-3.5" />
          新建
        </Button>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-fg-faint">
          还没有定时任务
        </div>
      ) : (
        <div className="divide-y divide-line rounded-xl border border-line">
          {list.map((s) => {
            const project = projects.find((p) => p.id === s.projectId)
            return (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                <AlarmClock
                  className={clsx('size-4 shrink-0', s.enabled ? 'text-accent' : 'text-fg-faint')}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    <Badge>{project ? project.name : '对话'}</Badge>
                    {s.lastError && <Badge tone="warn">上次失败</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-fg-faint" title={s.lastError ?? ''}>
                    {describeCron(s.cron)} · 下次 {s.enabled ? fmt(s.nextRunAt) : '已暂停'} · 上次{' '}
                    {fmt(s.lastRunAt)}
                    {s.lastError ? `（${s.lastError}）` : ''}
                  </div>
                </div>
                {s.lastConversationId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => useApp.getState().open(s.lastConversationId)}
                  >
                    查看上次
                  </Button>
                )}
                <IconButton label="立即运行" onClick={() => void runNow(s)}>
                  <Play className="size-3.5" />
                </IconButton>
                <IconButton label="编辑" onClick={() => setEditing(s)}>
                  <Pencil className="size-3.5" />
                </IconButton>
                <IconButton
                  label="删除"
                  onClick={() =>
                    confirmDialog(`删除定时任务「${s.name}」？`) &&
                    void succeeded(() => invoke('schedules.delete', s.id))
                  }
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
                <Toggle
                  checked={s.enabled}
                  label={s.enabled ? '暂停' : '启用'}
                  onChange={(enabled) =>
                    void succeeded(() => invoke('schedules.update', s.id, { enabled }))
                  }
                />
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <ScheduleForm
          schedule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function ScheduleForm({
  schedule,
  onClose,
}: {
  schedule: ScheduleDTO | null
  onClose: () => void
}) {
  const { projects, models } = useApp()
  const chatModels = models.filter((m) => m.capabilities.includes('chat'))
  const [name, setName] = useState(schedule?.name ?? '')
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '')
  const [projectId, setProjectId] = useState(schedule?.projectId ?? '')
  const [modelId, setModelId] = useState(schedule?.modelId ?? '')
  const [timing, setTiming] = useState<Timing>(fromCron(schedule?.cron ?? '0 9 * * *'))
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Timing>) => setTiming((t) => ({ ...t, ...patch }))
  const time = `${pad(timing.hour)}:${pad(timing.minute)}`

  const save = async () => {
    const input: ScheduleInput = {
      name,
      prompt,
      projectId: projectId || null,
      modelId: modelId || null,
      cron: toCron(timing),
    }
    setBusy(true)
    const ok = await succeeded(() =>
      schedule ? invoke('schedules.update', schedule.id, input) : invoke('schedules.create', input),
    )
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Modal open onClose={onClose} title={schedule ? '编辑定时任务' : '新建定时任务'}>
      <div className="space-y-4 p-5">
        <Field label="名称">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：每日简报"
          />
        </Field>
        <Field label="任务" hint="每次运行时作为第一条消息发送；可以用 /命令 或技能">
          <Textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例如：整理今天的 GitHub 通知，写一份摘要"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="运行位置">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">普通对话</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  项目：{p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="模型">
            <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
              <option value="">默认模型</option>
              {chatModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {modelLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="频率">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={timing.freq}
              onChange={(e) => {
                const freq = e.target.value as Freq
                set(freq === 'custom' ? { freq, custom: toCron(timing) } : { freq })
              }}
              className="w-32"
            >
              <option value="hourly">每小时</option>
              <option value="daily">每天</option>
              <option value="weekdays">工作日</option>
              <option value="weekly">每周</option>
              <option value="custom">自定义 cron</option>
            </Select>
            {timing.freq === 'weekly' && (
              <Select
                value={timing.weekday}
                onChange={(e) => set({ weekday: Number(e.target.value) })}
                className="w-24"
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={i} value={i}>
                    周{d}
                  </option>
                ))}
              </Select>
            )}
            {timing.freq === 'hourly' && (
              <Input
                type="number"
                min={0}
                max={59}
                value={timing.minute}
                onChange={(e) => set({ minute: Math.min(59, Math.max(0, Number(e.target.value))) })}
                className="w-24"
                aria-label="第几分钟"
              />
            )}
            {(timing.freq === 'daily' ||
              timing.freq === 'weekdays' ||
              timing.freq === 'weekly') && (
              <Input
                type="time"
                value={time}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number)
                  set({ hour: h ?? 0, minute: m ?? 0 })
                }}
                className="w-32"
              />
            )}
            {timing.freq === 'custom' && (
              <Input
                value={timing.custom}
                onChange={(e) => set({ custom: e.target.value })}
                placeholder="分 时 日 月 周，例如 */30 9-18 * * 1-5"
                className="flex-1 font-mono"
              />
            )}
          </div>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || !prompt.trim()}
            onClick={() => void save()}
          >
            保存
          </Button>
        </div>
      </div>
    </Modal>
  )
}
