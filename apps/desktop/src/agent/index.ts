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
  buildChatSystemPrompt,
  buildSubagentPrompt,
  buildSystemPrompt,
  Computer,
  createSubagent,
  hasHooks,
  Hooks,
  loadHooks,
  computerDisplayTool,
  computerTool,
  JobManager,
  loadProjectInstructions,
  loadSkills,
  loadUserInstructions,
  McpManager,
  nativeDriver,
  resolveShellEnv,
  sandboxAvailable,
  runAgent,
  shellFor,
  toolsForMode,
  type ApprovalDecision,
  type ApprovalRequest,
  type PermissionMode,
  type Skill,
  type ToolContext,
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
  approvals: Map<string, (d: ApprovalDecision, answers?: Record<string, string>) => void>
  /** Read on every tool call, so switching mode applies to the run in progress. */
  mode: PermissionMode
  /** Pending approvals that would now run without asking, given the current mode. */
  rechecks: Map<string, () => boolean>
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
  const run: Run = {
    controller: new AbortController(),
    approvals: new Map(),
    mode: req.agent?.mode ?? 'ask',
    rechecks: new Map(),
  }
  runs.set(runId, run)
  const allowed = new Set(req.agent?.allowed ?? [])

  try {
    let system = req.system
    let tools: typeof ALL_TOOLS = []
    let cwd = process.cwd()
    let env: NodeJS.ProcessEnv = process.env
    const sandbox = !!req.agent?.sandbox && sandboxAvailable()
    let skills: Skill[] = []
    let hooks: Hooks | undefined

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
      // Plain chats see the user's own skills; projects also see the project's.
      skills = await loadSkills(a.workspace ? null : cwd)
      const userInstructions = await loadUserInstructions()
      const hookConfig = await loadHooks(a.workspace ? null : cwd, { project: !!a.projectHooks })
      if (hasHooks(hookConfig))
        hooks = new Hooks(hookConfig, {
          cwd,
          env,
          platform: process.platform,
          sessionId: a.conversationId,
        })
      const hasSkills = skills.some((s) => s.kind === 'skill')
      tools = toolsForMode(
        [
          ...withNativeSearch(ALL_TOOLS, model).filter(
            (t) => hasSkills || t.definition.name !== 'skill',
          ),
          ...(a.browser ? BROWSER_TOOLS : []),
          ...(pcTool
            ? [pcTool, computerDisplayTool].map((t) => t as unknown as (typeof ALL_TOOLS)[number])
            : []),
          ...mcp.tools(),
        ],
        a.mode,
      )
      const browser =
        tools.some((t) => t.kind === 'browser') && (a.browserBackend === 'chrome' ? 'chrome' : true)
      const computer = tools.some((t) => t.kind === 'computer')
      const shell = shellFor(process.platform, env).name
      system = a.workspace
        ? buildChatSystemPrompt({
            cwd,
            platform: process.platform,
            shell,
            userSystemPrompt: a.userSystemPrompt ?? undefined,
            sandbox,
            browser,
            computer,
            skills,
            userInstructions,
          })
        : buildSystemPrompt({
            cwd,
            platform: process.platform,
            shell,
            mode: a.mode,
            projectName: a.projectName,
            projectInstructions: a.projectInstructions ?? undefined,
            fileInstructions: await loadProjectInstructions(cwd),
            userSystemPrompt: a.userSystemPrompt ?? undefined,
            sandbox,
            browser,
            computer,
            skills,
            userInstructions,
          })
    }

    const model = { provider: req.provider, modelId: req.modelId, protocol: req.protocol }
    const mode = () => run.mode
    const approve = (request: ApprovalRequest, recheck?: () => boolean) =>
      new Promise<ApprovalDecision>((resolve) => {
        run.approvals.set(request.toolCallId, (d) => {
          run.rechecks.delete(request.toolCallId)
          resolve(d)
        })
        if (recheck) run.rechecks.set(request.toolCallId, recheck)
        send({ type: 'run.approval', runId, request })
      })
    const ctx: ToolContext = {
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
      skills,
      ask: (questions, toolCallId = newId()) =>
        new Promise((resolve) => {
          run.approvals.set(toolCallId, (d, answers) =>
            resolve(d === 'deny' ? null : (answers ?? null)),
          )
          send({
            type: 'run.approval',
            runId,
            request: {
              toolCallId,
              name: 'ask_user',
              input: { questions },
              summary: questions[0]?.question ?? '向你提问',
              reason: 'Agent 想问你几个问题',
              danger: false,
              questions,
            },
          })
        }),
    }
    if (tools.some((t) => t.definition.name === 'task'))
      ctx.subagent = createSubagent({
        model,
        system: buildSubagentPrompt({ cwd, platform: process.platform }),
        thinking: req.thinking,
        tools,
        ctx,
        mode,
        allowed,
        approve,
      })

    const result = await runAgent({
      model,
      messages: req.messages as ModelMessage[],
      system,
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      thinking: req.thinking,
      tools,
      mode,
      allowed,
      ctx,
      onEvent: (event) => send({ type: 'run.event', runId, event }),
      approve,
      hooks,
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
    case 'run.mode': {
      const run = runs.get(msg.runId)
      if (!run) break
      run.mode = msg.mode
      // Let through what the new mode would no longer ask about.
      for (const [toolCallId, recheck] of run.rechecks) {
        const resolve = run.approvals.get(toolCallId)
        if (!resolve || !recheck()) continue
        run.approvals.delete(toolCallId)
        resolve('allow')
        send({ type: 'run.approval-resolved', runId: msg.runId, toolCallId })
      }
      break
    }
    case 'run.approve': {
      const run = runs.get(msg.runId)
      const resolve = run?.approvals.get(msg.toolCallId)
      if (resolve) {
        run!.approvals.delete(msg.toolCallId)
        resolve(msg.decision, msg.answers)
      }
      break
    }
  }
})
