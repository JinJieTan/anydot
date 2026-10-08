/**
 * Agent runtime, hosted in an Electron utilityProcess so model streams and
 * tool execution (shell commands, file edits) never block the UI or main.
 *
 * Main owns persistence; this process is stateless between runs apart from
 * the resolved login-shell environment.
 */
import {
  ALL_TOOLS,
  buildSystemPrompt,
  loadProjectInstructions,
  resolveShellEnv,
  runAgent,
  shellFor,
  toolsForMode,
  type ApprovalDecision,
} from '@aitech/agent'
import type { ModelMessage } from '@aitech/core'
import type { AgentRequest, AgentResponse, AgentRunRequest } from '../shared/ipc'

// Resolve once, in the background; the first command waits for it if needed.
const shellEnv = resolveShellEnv()

interface Run {
  controller: AbortController
  approvals: Map<string, (d: ApprovalDecision) => void>
}

const runs = new Map<string, Run>()

function send(res: AgentResponse) {
  process.parentPort.postMessage(res)
}

async function start(runId: string, req: AgentRunRequest) {
  const run: Run = { controller: new AbortController(), approvals: new Map() }
  runs.set(runId, run)
  const allowed = new Set(req.agent?.allowed ?? [])

  try {
    let system = req.system
    let tools: typeof ALL_TOOLS = []
    let cwd = process.cwd()
    let env: NodeJS.ProcessEnv = process.env

    if (req.agent) {
      const a = req.agent
      cwd = a.cwd
      env = await shellEnv
      tools = toolsForMode(ALL_TOOLS, a.mode)
      system = buildSystemPrompt({
        cwd,
        platform: process.platform,
        shell: shellFor(process.platform, env).name,
        mode: a.mode,
        projectName: a.projectName,
        projectInstructions: a.projectInstructions ?? undefined,
        fileInstructions: await loadProjectInstructions(cwd),
        userSystemPrompt: a.userSystemPrompt ?? undefined,
      })
    }

    const result = await runAgent({
      model: { provider: req.provider, modelId: req.modelId, protocol: req.protocol },
      messages: req.messages as ModelMessage[],
      system,
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      thinking: req.thinking,
      tools,
      mode: req.agent?.mode ?? 'ask',
      allowed,
      ctx: {
        cwd,
        env,
        platform: process.platform,
        signal: run.controller.signal,
        readFiles: new Map(),
        imageModel: req.agent?.imageModel,
      },
      onEvent: (event) => send({ type: 'run.event', runId, event }),
      approve: (request) =>
        new Promise<ApprovalDecision>((resolve) => {
          run.approvals.set(request.toolCallId, resolve)
          send({ type: 'run.approval', runId, request })
        }),
    })
    send({
      type: 'run.end',
      runId,
      status: result.status,
      error: result.error,
      allowed: [...allowed],
    })
  } catch (err) {
    send({
      type: 'run.end',
      runId,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      allowed: [...allowed],
    })
  } finally {
    runs.delete(runId)
  }
}

process.parentPort.on('message', (event) => {
  const msg = event.data as AgentRequest
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong', id: msg.id, pid: process.pid })
      break
    case 'run.start':
      void start(msg.runId, msg.request)
      break
    case 'run.abort': {
      const run = runs.get(msg.runId)
      if (!run) break
      run.controller.abort()
      // Unblock any pending approval so the loop can observe the abort.
      for (const resolve of run.approvals.values()) resolve('deny')
      run.approvals.clear()
      break
    }
    case 'run.approve': {
      const run = runs.get(msg.runId)
      const resolve = run?.approvals.get(msg.toolCallId)
      if (resolve) {
        run!.approvals.delete(msg.toolCallId)
        resolve(msg.decision)
      }
      break
    }
  }
})
