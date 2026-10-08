import { spawnCommand, truncateOutput, type SpawnOptions } from './shell'

/** Output kept per job; older output is dropped from the front. */
const MAX_BUFFER = 200_000
const MAX_JOBS_PER_SCOPE = 5

export interface Job {
  id: string
  command: string
  startedAt: number
  /** null while running. */
  exitCode: number | null
  running: boolean
  /** Everything kept so far, and how much of it the model has already seen. */
  buffer: string
  dropped: number
  readTo: number
  kill: (force?: boolean) => void
  /** Wakes waiters on new output or exit. */
  listeners: Set<() => void>
}

/**
 * Long-running commands started with `bash run_in_background` (dev servers,
 * watchers). Jobs belong to a scope (a conversation), outlive a single agent
 * run, and are killed when the scope is cleared or the process exits.
 */
export class JobManager {
  private scopes = new Map<string, Map<string, Job>>()
  private seq = 0

  scope(name: string): JobScope {
    return new JobScope(this, name)
  }

  /** @internal */
  jobs(scope: string): Map<string, Job> {
    let jobs = this.scopes.get(scope)
    if (!jobs) this.scopes.set(scope, (jobs = new Map()))
    return jobs
  }

  /** @internal */
  nextId(): string {
    return `job${++this.seq}`
  }

  /** Kill every job in a scope, e.g. when its conversation is deleted. */
  clear(scope: string) {
    for (const job of this.scopes.get(scope)?.values() ?? []) job.kill()
    this.scopes.delete(scope)
  }

  /** Synchronous, for process exit. */
  killAll() {
    for (const jobs of this.scopes.values()) for (const job of jobs.values()) job.kill(true)
  }
}

export class JobScope {
  constructor(
    private readonly manager: JobManager,
    private readonly name: string,
  ) {}

  private get jobs() {
    return this.manager.jobs(this.name)
  }

  list(): Job[] {
    return [...this.jobs.values()]
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  start(command: string, opts: SpawnOptions): Job {
    const running = this.list().filter((j) => j.running)
    if (running.length >= MAX_JOBS_PER_SCOPE) {
      throw new Error(
        `Too many background jobs (${running.length}); stop one with kill_job first: ` +
          running.map((j) => j.id).join(', '),
      )
    }
    // Forget finished jobs once there are more than a handful.
    const finished = this.list().filter((j) => !j.running)
    for (const j of finished.slice(0, Math.max(0, finished.length - MAX_JOBS_PER_SCOPE)))
      this.jobs.delete(j.id)

    const { child, kill } = spawnCommand(command, opts)
    const job: Job = {
      id: this.manager.nextId(),
      command,
      startedAt: Date.now(),
      exitCode: null,
      running: true,
      buffer: '',
      dropped: 0,
      readTo: 0,
      kill,
      listeners: new Set(),
    }
    const notify = () => {
      for (const l of job.listeners) l()
    }
    const onData = (d: Buffer) => {
      job.buffer += d.toString('utf8')
      if (job.buffer.length > MAX_BUFFER) {
        const cut = job.buffer.length - MAX_BUFFER
        job.buffer = job.buffer.slice(cut)
        job.dropped += cut
      }
      notify()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => onData(Buffer.from(`\n${err.message}\n`)))
    child.on('close', (code) => {
      job.running = false
      job.exitCode = code
      notify()
    })
    this.jobs.set(job.id, job)
    return job
  }

  /**
   * New output since the last read. Waits up to `waitMs` for the job's
   * output to match `until` (or for any new output, or the job to exit).
   */
  async read(
    job: Job,
    opts: { waitMs?: number; until?: RegExp; signal?: AbortSignal } = {},
  ): Promise<{ output: string; matched: boolean }> {
    const unread = () => job.buffer.slice(Math.max(0, job.readTo - job.dropped))
    // `until` looks at everything the job printed, so a "ready" line that an
    // earlier read already returned still counts.
    const done = () =>
      !job.running || (opts.until ? opts.until.test(job.buffer) : unread().length > 0)
    if (opts.waitMs && !done()) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          job.listeners.delete(check)
          opts.signal?.removeEventListener('abort', finish)
          resolve()
        }
        const check = () => done() && finish()
        const timer = setTimeout(finish, opts.waitMs)
        job.listeners.add(check)
        opts.signal?.addEventListener('abort', finish, { once: true })
      })
    }
    const output = unread()
    job.readTo = job.dropped + job.buffer.length
    return { output: truncateOutput(output), matched: !!opts.until?.test(job.buffer) }
  }
}

export function describeJob(job: Job): string {
  const age = Math.round((Date.now() - job.startedAt) / 1000)
  const state = job.running ? `running for ${age}s` : `exited with code ${job.exitCode}`
  return `${job.id}: ${job.command} (${state})`
}
