import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { AgentEvent, ApprovalDecision, ApprovalRequest } from '@aitech/agent'
import { newId } from '@aitech/core'
import type { AgentRequest, AgentResponse, AgentRunRequest } from '../shared/ipc'

export type RunEnd = Extract<AgentResponse, { type: 'run.end' }>

export interface RunHandlers {
  onEvent: (event: AgentEvent) => void
  onApproval: (request: ApprovalRequest) => void
  onEnd: (end: RunEnd) => void
}

export interface RunHandle {
  runId: string
  abort: () => void
  approve: (
    toolCallId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
  ) => void
}

/** Owns the agent utilityProcess and restarts it if it exits unexpectedly. */
export class AgentHost {
  private child: UtilityProcess | null = null
  private pings = new Map<string, (pid: number) => void>()
  private replies = new Map<string, (res: AgentResponse) => void>()
  private runs = new Map<string, RunHandlers>()
  private stopping = false
  /** Called after every (re)start, so state like MCP config can be re-sent. */
  onStart: (() => void) | null = null
  onMcpStatus: ((servers: import('../shared/ipc').McpServerStatus[]) => void) | null = null
  /** Serves the agent's host calls (e.g. the built-in browser). */
  onHostCall: ((method: string, params: unknown) => Promise<unknown>) | null = null
  /** The agent process's stdout / stderr (console output, crash traces). */
  onOutput: ((stream: 'stdout' | 'stderr', text: string) => void) | null = null

  start(): void {
    this.stopping = false
    const child = utilityProcess.fork(join(__dirname, 'agent.js'), [], {
      serviceName: 'aitech-agent',
      stdio: 'pipe',
    })
    child.stdout?.on('data', (d: Buffer) => this.onOutput?.('stdout', d.toString()))
    child.stderr?.on('data', (d: Buffer) => this.onOutput?.('stderr', d.toString()))
    child.on('message', (res: AgentResponse) => this.onMessage(res))
    child.on('exit', (code) => {
      this.child = null
      // Fail in-flight runs so their messages don't stay "streaming" forever.
      for (const [runId, run] of this.runs) {
        run.onEnd({
          type: 'run.end',
          runId,
          status: 'error',
          error: 'Agent 进程意外退出，请重试',
          allowed: [],
        })
      }
      this.runs.clear()
      if (!this.stopping) {
        console.error(`[agent] exited with code ${code}, restarting`)
        setTimeout(() => this.start(), 1000)
      }
    })
    this.child = child
    this.onStart?.()
  }

  stop(): void {
    this.stopping = true
    const child = this.child
    this.child = null
    if (!child) return
    // Let it stop its background jobs first (Windows can't signal it to), then make sure.
    child.postMessage({ type: 'shutdown' } satisfies AgentRequest)
    setTimeout(() => child.kill(), 1000).unref()
  }

  private post(msg: AgentRequest) {
    if (!this.child) throw new Error('Agent 进程未运行')
    this.child.postMessage(msg)
  }

  private onMessage(res: AgentResponse) {
    switch (res.type) {
      case 'pong':
        this.pings.get(res.id)?.(res.pid)
        this.pings.delete(res.id)
        break
      case 'computer.displays':
        this.replies.get(res.id)?.(res)
        this.replies.delete(res.id)
        break
      case 'mcp.status':
        this.onMcpStatus?.(res.servers)
        break
      case 'run.event':
        this.runs.get(res.runId)?.onEvent(res.event)
        break
      case 'run.approval':
        this.runs.get(res.runId)?.onApproval(res.request)
        break
      case 'run.end':
        this.runs.get(res.runId)?.onEnd(res)
        this.runs.delete(res.runId)
        break
      case 'host.call': {
        const handler = this.onHostCall
        const reply = (msg: AgentRequest) => {
          // The process may have restarted meanwhile; the stale call is moot.
          if (this.child) this.post(msg)
        }
        if (!handler) {
          reply({ type: 'host.result', id: res.id, error: 'host calls are not supported' })
          break
        }
        handler(res.method, res.params).then(
          (result) => reply({ type: 'host.result', id: res.id, result }),
          (err: unknown) =>
            reply({
              type: 'host.result',
              id: res.id,
              error: err instanceof Error ? err.message : String(err),
            }),
        )
        break
      }
    }
  }

  /** Stop a conversation's background jobs. */
  clearJobs(conversationId: string) {
    if (this.child) this.post({ type: 'jobs.clear', conversationId })
  }

  configureMcp(servers: import('@aitech/agent').McpServerConfig[]) {
    if (this.child) this.post({ type: 'mcp.configure', servers })
  }

  run(request: AgentRunRequest, handlers: RunHandlers): RunHandle {
    const runId = newId()
    this.runs.set(runId, handlers)
    try {
      this.post({ type: 'run.start', runId, request })
    } catch (err) {
      this.runs.delete(runId)
      queueMicrotask(() =>
        handlers.onEnd({
          type: 'run.end',
          runId,
          status: 'error',
          error: (err as Error).message,
          allowed: [],
        }),
      )
    }
    return {
      runId,
      abort: () => {
        if (this.runs.has(runId)) this.post({ type: 'run.abort', runId })
      },
      approve: (toolCallId, decision, answers) => {
        if (this.runs.has(runId))
          this.post({ type: 'run.approve', runId, toolCallId, decision, answers })
      },
    }
  }

  /** The displays the computer tool can work on, as the agent's driver sees them. */
  displays(): Promise<import('@aitech/agent').DisplayInfo[]> {
    if (!this.child) return Promise.reject(new Error('Agent 进程未运行'))
    const id = newId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(id)
        reject(new Error('读取显示器超时'))
      }, 15_000)
      this.replies.set(id, (res) => {
        clearTimeout(timer)
        if (res.type !== 'computer.displays') return
        if (res.error !== undefined) reject(new Error(res.error))
        else resolve(res.displays ?? [])
      })
      this.post({ type: 'computer.displays', id })
    })
  }

  async ping(timeoutMs = 2000): Promise<{ ok: boolean; pid?: number; latencyMs: number }> {
    if (!this.child) return { ok: false, latencyMs: 0 }
    const id = newId()
    const started = performance.now()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pings.delete(id)
        resolve({ ok: false, latencyMs: timeoutMs })
      }, timeoutMs)
      this.pings.set(id, (pid) => {
        clearTimeout(timer)
        resolve({ ok: true, pid, latencyMs: Math.round(performance.now() - started) })
      })
      this.post({ type: 'ping', id })
    })
  }
}
