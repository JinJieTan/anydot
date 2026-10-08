/**
 * Agent runtime, hosted in an Electron utilityProcess so network streams and
 * (from M2) tool execution never block the UI or the main process.
 */
import { streamChat, type ModelMessage } from '@aitech/core'
import type { AgentChatStart, AgentRequest, AgentResponse } from '../shared/ipc'

const runs = new Map<string, AbortController>()

function send(res: AgentResponse) {
  process.parentPort.postMessage(res)
}

async function runChat({ runId, request }: AgentChatStart) {
  const controller = new AbortController()
  runs.set(runId, controller)
  try {
    for await (const event of streamChat({
      model: {
        provider: request.provider,
        modelId: request.modelId,
        protocol: request.protocol,
      },
      messages: request.messages as ModelMessage[],
      system: request.system,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      thinking: request.thinking,
      signal: controller.signal,
    })) {
      send({ type: 'chat.event', runId, event })
    }
  } catch (err) {
    send({
      type: 'chat.event',
      runId,
      event: { type: 'error', message: err instanceof Error ? err.message : String(err) },
    })
  } finally {
    runs.delete(runId)
    send({ type: 'chat.end', runId, aborted: controller.signal.aborted })
  }
}

process.parentPort.on('message', (event) => {
  const msg = event.data as AgentRequest
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong', id: msg.id, pid: process.pid })
      break
    case 'chat.start':
      void runChat(msg)
      break
    case 'chat.abort':
      runs.get(msg.runId)?.abort()
      break
  }
})
