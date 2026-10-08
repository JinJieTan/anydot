/**
 * Agent runtime, hosted in an Electron utilityProcess so model streams and
 * tool execution (shell commands, file edits) never block the UI or main.
 *
 * Main owns persistence; this process is stateless between runs apart from
 * the resolved login-shell environment.
 */
import {
  ALL_TOOLS,
  BROWSER_TOOLS,
  buildSystemPrompt,
  Computer,
  computerDisplayTool,
  computerTool,
  JobManager,
  loadProjectInstructions,
  McpManager,
  nativeDriver,
  resolveShellEnv,
  sandboxAvailable,
  runAgent,
  shellFor,
  toolsForMode,
  type ApprovalDecision,
} from '@aitech/agent'
import {
  newId,
  nativeComputerTool,
  nativeWebSearchTool,
  type ModelMessage,
  type ModelRef,
} from '@aitech/core'
import type { AgentRequest, AgentResponse, AgentRunRequest } from '../shared/ipc'

// Resolve once, in the background; the first command waits for it if needed.
const shellEnv = resolveShellEnv()

interface Run {
  controller: AbortController
  approvals: Map<string, (d: ApprovalDecision) => void>
}

const runs = new Map<string, Run>()
const mcp = new McpManager(() => shellEnv)
const jobs = new JobManager()

// Background jobs run in their own process groups and would outlive us.
process.on('exit', () => jobs.killAll())
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    jobs.killAll()
    process.exit(0)
  })

function send(res: AgentResponse) {
  process.parentPort.postMessage(res)
}

const hostCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** Ask main to do something only it can (e.g. drive the browser window). */
function host(method: string, params: unknown): Promise<unknown> {
  const id = newId()
  return new Promise((resolve, reject) => {
    hostCalls.set(id, { resolve, reject })
    send({ type: 'host.call', id, method, params })
  })
}

// Created on first use and kept, so the Windows helper process is reused.
let computer: Computer | null | undefined
function getComputer(): Computer | null {
  if (computer === undefined) {
    const driver = nativeDriver(process.platform)
    computer = driver ? new Computer(driver) : null
  }
  return computer
}

/** On the official APIs, web_search becomes the provider's own (server-side) search. */
function withNativeSearch(tools: typeof ALL_TOOLS, model: ModelRef): typeof ALL_TOOLS {
  const native = nativeWebSearchTool(model)
  if (!native) return tools
  return tools.map((t) =>
    t.definition.name === 'web_search'
      ? { ...t, definition: { ...t.definition, provider: native } }
      : t,
  )
}

/** The computer tool, provider-native when the model and endpoint support it. */
async function buildComputerTool(model: ModelRef) {
  const pc = getComputer()
  if (!pc) return null
  let native = null
  try {
    native = nativeComputerTool(model, await pc.display())
  } catch {
    // Screen size unavailable (permissions?): the function tool still works and reports errors.
  }
  return computerTool(native)
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
    const sandbox = !!req.agent?.sandbox && sandboxAvailable()

    if (req.agent) {
      const a = req.agent
      cwd = a.cwd
      env = await shellEnv
      const model = { provider: req.provider, modelId: req.modelId, protocol: req.protocol }
      // Each run starts on the display chosen in settings.
      if (a.computer)
        await getComputer()
          ?.useDisplay(a.computerDisplay ?? null)
          .catch(() => {})
      const pcTool = a.computer ? await buildComputerTool(model) : null
      tools = toolsForMode(
        [
          ...withNativeSearch(ALL_TOOLS, model),
          ...(a.browser ? BROWSER_TOOLS : []),
          ...(pcTool
            ? [pcTool, computerDisplayTool].map((t) => t as unknown as (typeof ALL_TOOLS)[number])
            : []),
          ...mcp.tools(),
        ],
        a.mode,
      )
      system = buildSystemPrompt({
        cwd,
        platform: process.platform,
        shell: shellFor(process.platform, env).name,
        mode: a.mode,
        projectName: a.projectName,
        projectInstructions: a.projectInstructions ?? undefined,
        fileInstructions: await loadProjectInstructions(cwd),
        userSystemPrompt: a.userSystemPrompt ?? undefined,
        sandbox,
        browser: tools.some((t) => t.kind === 'browser'),
        computer: tools.some((t) => t.kind === 'computer'),
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
        host,
        computer: req.agent?.computer ? (getComputer() ?? undefined) : undefined,
        computerBlocked: req.agent?.computerBlocked,
        sandbox,
        jobs: req.agent ? jobs.scope(req.agent.conversationId) : undefined,
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
    case 'host.result': {
      const call = hostCalls.get(msg.id)
      if (!call) break
      hostCalls.delete(msg.id)
      if (msg.error !== undefined) call.reject(new Error(msg.error))
      else call.resolve(msg.result)
      break
    }
    case 'computer.displays': {
      const pc = getComputer()
      if (!pc) send({ type: 'computer.displays', id: msg.id, displays: [] })
      else
        pc.displays().then(
          (displays) => send({ type: 'computer.displays', id: msg.id, displays }),
          (err: unknown) =>
            send({ type: 'computer.displays', id: msg.id, error: (err as Error).message }),
        )
      break
    }
    case 'shutdown':
      jobs.killAll()
      process.exit(0)
      break
    case 'jobs.clear':
      jobs.clear(msg.conversationId)
      break
    case 'mcp.configure':
      void mcp.configure(msg.servers).then((servers) => send({ type: 'mcp.status', servers }))
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
