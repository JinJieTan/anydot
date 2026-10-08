import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { newId } from '@aitech/core'
import type { AgentPong, AgentRequest, AgentResponse } from '../shared/ipc'

/** Owns the agent utilityProcess and restarts it if it exits unexpectedly. */
export class AgentHost {
  private child: UtilityProcess | null = null
  private pending = new Map<string, (res: AgentResponse) => void>()
  private stopping = false

  start(): void {
    this.stopping = false
    const child = utilityProcess.fork(join(__dirname, 'agent.js'), [], {
      serviceName: 'aitech-agent',
    })
    child.on('message', (res: AgentResponse) => {
      this.pending.get(res.id)?.(res)
      this.pending.delete(res.id)
    })
    child.on('exit', (code) => {
      this.child = null
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

  async ping(timeoutMs = 2000): Promise<AgentPong> {
    const child = this.child
    if (!child) return { ok: false, latencyMs: 0, error: 'agent not running' }

    const id = newId()
    const started = performance.now()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, latencyMs: timeoutMs, error: 'timeout' })
      }, timeoutMs)
      this.pending.set(id, (res) => {
        clearTimeout(timer)
        resolve({ ok: true, latencyMs: Math.round(performance.now() - started), pid: res.pid })
      })
      child.postMessage({ type: 'ping', id } satisfies AgentRequest)
    })
  }
}
