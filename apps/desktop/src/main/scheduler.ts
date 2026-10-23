import { stat } from 'node:fs/promises'
import type { ScheduleInput, ScheduleRow, Store } from '@aitech/db'
import type { Settings } from '../shared/ipc'
import type { ChatService } from './chat-service'
import { nextRun, parseCron } from './cron'

const TICK_MS = 20_000

/**
 * Runs scheduled tasks: at each due time a new conversation (in the
 * schedule's project, or a plain chat) is started with the schedule's prompt.
 * A run missed while the app was closed happens once at the next start.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: Store,
    private readonly chat: ChatService,
    private readonly settings: () => Settings,
    /** Schedules or conversations changed. */
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): ScheduleRow[] {
    return this.store.listSchedules()
  }

  create(input: ScheduleInput): ScheduleRow {
    const clean = this.validate(input)
    const s = this.store.createSchedule({ ...clean, nextRunAt: nextRun(clean.cron, this.now()) })
    this.changed()
    return s
  }

  update(id: string, patch: Partial<ScheduleInput> & { enabled?: boolean }): ScheduleRow {
    const cur = this.store.getSchedule(id)
    if (!cur) throw new Error('定时任务不存在')
    const clean = this.validate({ ...cur, ...patch })
    const enabled = patch.enabled ?? cur.enabled
    // Re-plan from now when the timing changes or the task is switched back on.
    const replan = clean.cron !== cur.cron || (enabled && !cur.enabled)
    const s = this.store.updateSchedule(id, {
      ...clean,
      enabled,
      ...(replan ? { nextRunAt: nextRun(clean.cron, this.now()) } : {}),
    })
    this.changed()
    return s
  }

  delete(id: string): void {
    this.store.deleteSchedule(id)
    this.changed()
  }

  /** Start a run now, whatever the schedule says; returns the new conversation's id. */
  async runNow(id: string): Promise<string> {
    const s = this.store.getSchedule(id)
    if (!s) throw new Error('定时任务不存在')
    return this.fire(s)
  }

  private validate(input: ScheduleInput): ScheduleInput {
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (!name) throw new Error('请填写名称')
    if (!prompt) throw new Error('请填写要执行的任务')
    parseCron(input.cron)
    if (input.projectId && !this.store.getProject(input.projectId)) throw new Error('项目不存在')
    return { ...input, name, prompt, cron: input.cron.trim().replace(/\s+/g, ' ') }
  }

  private ticking = false

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      for (const s of this.store.listSchedules()) {
        if (!s.enabled || s.nextRunAt === null || s.nextRunAt > now) continue
        // Plan the next run first, so a failing run never repeats every tick.
        this.store.updateSchedule(s.id, { nextRunAt: nextRun(s.cron, now) })
        // Don't pile up: skip while the previous run is still going.
        if (s.lastConversationId && this.chat.runningConversations().includes(s.lastConversationId))
          continue
        await this.fire(s).catch(() => {})
      }
    } finally {
      this.ticking = false
    }
  }

  private async fire(s: ScheduleRow): Promise<string> {
    try {
      const project = s.projectId ? this.store.getProject(s.projectId) : undefined
      if (s.projectId && !project) throw new Error('项目已被删除')
      if (project && !(await stat(project.rootPath).catch(() => null)))
        throw new Error(`项目文件夹不存在：${project.rootPath}`)
      const settings = this.settings()
      const conv = this.store.createConversation({
        projectId: project?.id ?? null,
        modelId: s.modelId ?? project?.defaultModelId ?? settings.defaultModelId,
        thinking: settings.defaultThinking,
      })
      this.store.updateConversation(conv.id, { title: `⏰ ${s.name}` })
      this.store.updateSchedule(s.id, {
        lastRunAt: this.now(),
        lastConversationId: conv.id,
        lastError: null,
      })
      this.changed()
      await this.chat.send(conv.id, s.prompt, [])
      return conv.id
    } catch (err) {
      this.store.updateSchedule(s.id, { lastRunAt: this.now(), lastError: (err as Error).message })
      this.changed()
      throw err
    }
  }
}
