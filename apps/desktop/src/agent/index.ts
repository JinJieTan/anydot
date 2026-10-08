/**
 * Agent runtime, hosted in an Electron utilityProcess so a crash or a
 * long-running tool never blocks the UI. M2 moves the agent loop here.
 */
import type { AgentRequest, AgentResponse } from '../shared/ipc'

process.parentPort.on('message', (event) => {
  const msg = event.data as AgentRequest
  if (msg.type === 'ping') {
    const res: AgentResponse = { type: 'pong', id: msg.id, pid: process.pid }
    process.parentPort.postMessage(res)
  }
})
