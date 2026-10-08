import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { newId } from '@aitech/core'
import type { AgentChatStart, AgentRequest, AgentResponse } from '../shared/ipc'

type ChatEvent = Extract<AgentResponse, { type: 'chat.event' }>['event']

interface RunHandlers {
  onEvent: (event: ChatEvent) => void
  onEnd: (aborted: boolean) => void
}

/** Owns the agent utilityProcess and restarts it if it exits unexpectedly. */
export class AgentHost {
  private child: UtilityProcess | null = null
  private pings = new Map<string, (pid: number) => void>()
  private runs = new Map<string, RunHandlers>()
  private stopping = false

  start(): void {
    this.stopping = false
    const child = utilityProcess.fork(join(__dirname, 'agent.js'), [], {
      serviceName: 'aitech-agent',
    })
    child.on('message', (res: AgentResponse) => this.onMessage(res))
    child.on('exit', (code) => {
      this.child = null
      // Fail any in-flight runs so their messages don't stay "streaming" forever.
      for (const [runId, run] of this.runs) {
        run.onEvent({ type: 'error', message: 'Agent 进程意外退出，请重试' })
        run.onEnd(false)
        this.runs.delete(runId)
      }
      if (!this.stopping) {
        console.error(`[agent] exited with code ${code}, restarting`)
        setTimeout(() => this.start(), 1000)
      }
    })
    this.child = child
  }

  stop(): void {
    this.stopping = true
    this.child?.kill()
    this.child = null
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
      case 'chat.event':
        this.runs.get(res.runId)?.onEvent(res.event)
        break
      case 'chat.end':
        this.runs.get(res.runId)?.onEnd(res.aborted)
        this.runs.delete(res.runId)
        break
    }
  }

  /** Start a model stream. Returns a function that aborts it. */
  chat(request: AgentChatStart['request'], handlers: RunHandlers): () => void {
    const runId = newId()
    this.runs.set(runId, handlers)
    try {
      this.post({ type: 'chat.start', runId, request })
    } catch (err) {
      this.runs.delete(runId)
      handlers.onEvent({ type: 'error', message: (err as Error).message })
      handlers.onEnd(false)
    }
    return () => {
      if (this.runs.has(runId)) this.post({ type: 'chat.abort', runId })
    }
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
