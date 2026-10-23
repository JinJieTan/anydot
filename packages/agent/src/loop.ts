import {
  defineTools,
  errorMessage,
  streamChat,
  summaryPrompt,
  toolOutput,
  type MessagePart,
  type ModelMessage,
  type ModelRef,
  type ThinkingLevel,
  type ToolImage,
  type Usage,
} from '@aitech/core'
import type { Hooks } from './hooks'
import { allowKey, decide, type PermissionMode } from './permissions'
import {
  ToolInputError,
  type AgentTool,
  type FileBackup,
  type Question,
  type ToolContext,
  type ToolResult,
} from './tools/types'

export type ApprovalDecision = 'allow' | 'allow-always' | 'deny'

export interface ApprovalRequest {
  toolCallId: string
  name: string
  input: unknown
  summary: string
  reason: string
  danger: boolean
  /** Set for the ask_user tool: answer these instead of allowing or denying. */
  questions?: Question[]
}

export type AgentEvent =
  | { type: 'step-start' }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'step-end'
      parts: MessagePart[]
      usage: Usage | null
      finishReason: string | null
      error?: string
    }
  | {
      type: 'tool-result'
      toolCallId: string
      name: string
      output: string
      isError: boolean
      images?: ToolImage[]
      backups?: FileBackup[]
    }
  /** History was summarised to stay within the context window. */
  | { type: 'compacted'; summary: string }

export interface RunAgentOptions {
  model: ModelRef
  messages: ModelMessage[]
  system?: string
  temperature?: number
  maxOutputTokens?: number
  thinking?: ThinkingLevel
  /** Empty for plain chat: a single model turn with no tools. */
  tools: AgentTool<never>[]
  ctx: ToolContext
  mode: PermissionMode
  /** Session-scoped "always allow" keys; mutated when the user picks allow-always. */
  allowed?: Set<string>
  maxSteps?: number
  /** Summarise the history once a step's input exceeds this many tokens. */
  compactAtTokens?: number
  onEvent: (e: AgentEvent) => void
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>
  /** User-configured commands run before/after tool calls and when the agent stops. */
  hooks?: Hooks
}

/** How many times Stop hooks may send the agent back to work in one run. */
const MAX_STOP_CONTINUES = 3

export interface RunAgentResult {
  status: 'done' | 'aborted' | 'error' | 'max-steps'
  error?: string
  steps: number
}

/** Readable text for a provider-run tool's result (search results etc.), for display. */
export function describeServerOutput(output: unknown): string {
  if (typeof output === 'string') return output
  // Anthropic web search: [{ url, title, pageAge, encryptedContent }]
  if (Array.isArray(output) && output.every((r) => r && typeof r === 'object' && 'url' in r)) {
    return output
      .map(
        (r: { url: string; title?: string | null }, i) =>
          `${i + 1}. ${r.title ?? r.url}\n   ${r.url}`,
      )
      .join('\n')
  }
  const json = JSON.stringify(
    output,
    (k, v: unknown) => (k === 'encryptedContent' ? undefined : v),
    2,
  )
  return json && json.length > 4000 ? `${json.slice(0, 4000)}…` : (json ?? '')
}

/** Screenshots are large; only the latest few stay in the context. */
const KEEP_IMAGES = 3

/**
 * Replace all but the newest `keep` tool-result images with a short note.
 * Only kicks in once there are `slack` extra images, so the (cache-busting)
 * rewrite of earlier history happens every few screenshots, not every step.
 */
export function dropOldImages(history: ModelMessage[], keep: number, slack = 0) {
  const count = history.reduce(
    (n, m) =>
      n +
      (m.role === 'tool'
        ? m.content.filter(
            (p) =>
              p.type === 'tool-result' &&
              p.output.type === 'content' &&
              p.output.value.some((v) => v.type === 'file'),
          ).length
        : 0),
    0,
  )
  if (count <= keep + slack) return
  let seen = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!
    if (msg.role !== 'tool') continue
    for (const part of msg.content) {
      if (part.type !== 'tool-result' || part.output.type !== 'content') continue
      const value = part.output.value
      if (!value.some((v) => v.type === 'file')) continue
      if (++seen <= keep) continue
      const text = value.flatMap((v) => (v.type === 'text' ? [v.text] : [])).join('\n')
      part.output = { type: 'text', value: `${text}\n[screenshot omitted to save context]` }
    }
  }
}

const PARALLEL_TOOL = 'task'

const DENIED =
  'The user denied this action. Do not retry it; continue without it or ask the user how to proceed.'
const ABORTED = 'Stopped by the user before this ran.'

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { ctx, onEvent } = opts
  const maxSteps = opts.maxSteps ?? 50
  const allowed = opts.allowed ?? new Set<string>()
  const toolSet = opts.tools.length ? defineTools(opts.tools.map((t) => t.definition)) : undefined
  const byName = new Map(opts.tools.map((t) => [t.definition.name, t]))
  let history = [...opts.messages]
  let stopContinues = 0

  for (let step = 1; step <= maxSteps; step++) {
    if (ctx.signal.aborted) return { status: 'aborted', steps: step - 1 }
    onEvent({ type: 'step-start' })

    let text = ''
    let reasoning = ''
    const calls: { id: string; name: string; input: unknown }[] = []
    // Run by the provider (native web search): shown and stored, never executed here.
    const serverCalls: { id: string; name: string; input: unknown }[] = []
    const serverResults: { id: string; name: string; output: unknown; isError: boolean }[] = []
    let usage: Usage | null = null
    let finishReason: string | null = null
    let error: string | undefined
    let response: ModelMessage[] | null = null

    for await (const e of streamChat({
      model: opts.model,
      messages: history,
      system: opts.system,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
      thinking: opts.thinking,
      tools: toolSet,
      signal: ctx.signal,
    })) {
      switch (e.type) {
        case 'text':
          text += e.text
          onEvent(e)
          break
        case 'reasoning':
          reasoning += e.text
          onEvent(e)
          break
        case 'tool-call':
          calls.push({ id: e.id, name: e.name, input: e.input })
          break
        case 'server-tool-call':
          serverCalls.push({ id: e.id, name: e.name, input: e.input })
          break
        case 'server-tool-result':
          serverResults.push(e)
          break
        case 'finish':
          usage = e.usage
          finishReason = e.finishReason
          break
        case 'response':
          response = e.messages
          break
        case 'error':
          error = e.message
          break
      }
    }

    const parts: MessagePart[] = [
      ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      ...serverCalls.map((c) => ({
        type: 'tool_call' as const,
        id: c.id,
        name: c.name,
        input: c.input,
        server: true,
      })),
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...calls.map((c) => ({ type: 'tool_call' as const, id: c.id, name: c.name, input: c.input })),
    ]
    onEvent({ type: 'step-end', parts, usage, finishReason, error })
    for (const r of serverResults)
      onEvent({
        type: 'tool-result',
        toolCallId: r.id,
        name: r.name,
        output: describeServerOutput(r.output),
        isError: r.isError,
      })

    if (error) return { status: 'error', error, steps: step }
    if (ctx.signal.aborted) {
      // Close out the calls the model made so the transcript stays valid.
      for (const c of calls)
        onEvent({
          type: 'tool-result',
          toolCallId: c.id,
          name: c.name,
          output: ABORTED,
          isError: true,
        })
      return { status: 'aborted', steps: step }
    }
    if (!calls.length) {
      // A long server-tool turn was paused: send it back as-is to let it continue.
      if (finishReason === 'pause_turn' && response) {
        history.push(...(response as ModelMessage[]))
        continue
      }
      // A Stop hook can send the agent back to work, e.g. "tests still fail".
      if (opts.hooks && stopContinues < MAX_STOP_CONTINUES) {
        const stop = await opts.hooks.run(
          'Stop',
          { stop_hook_active: stopContinues > 0 },
          ctx.signal,
        )
        if (stop.block && !ctx.signal.aborted) {
          stopContinues++
          history.push(
            ...(response ?? [{ role: 'assistant' as const, content: text || '(done)' }]),
            { role: 'user', content: `A Stop hook asked you to continue:\n${stop.block}` },
          )
          continue
        }
      }
      return { status: 'done', steps: step }
    }

    // Prefer the SDK's own replay of the turn: it carries signed thinking blocks
    // that Anthropic requires when continuing a tool loop.
    history.push(
      ...(response ?? [
        {
          role: 'assistant' as const,
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...calls.map((c) => ({
              type: 'tool-call' as const,
              toolCallId: c.id,
              toolName: c.name,
              input: c.input,
            })),
          ],
        },
      ]),
    )

    const results: { toolCallId: string; toolName: string; output: ToolResult }[] = []
    // Calls run one by one, except that consecutive sub-agent tasks run in parallel.
    for (let i = 0; i < calls.length;) {
      let j = i + 1
      if (calls[i]!.name === PARALLEL_TOOL)
        while (j < calls.length && calls[j]!.name === PARALLEL_TOOL) j++
      const batch = calls.slice(i, j)
      const outputs = await Promise.all(batch.map((c) => executeCall(c, byName, opts, allowed)))
      for (const [k, call] of batch.entries()) {
        const output = outputs[k]!
        results.push({ toolCallId: call.id, toolName: call.name, output })
        onEvent({
          type: 'tool-result',
          toolCallId: call.id,
          name: call.name,
          output: output.output,
          isError: !!output.isError,
          images: output.images,
          backups: output.backups,
        })
      }
      i = j
    }
    history.push({
      role: 'tool',
      content: results.map((r) => ({
        type: 'tool-result' as const,
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: toolOutput(r.output.output, !!r.output.isError, r.output.images),
      })),
    })
    dropOldImages(history, KEEP_IMAGES, 3)

    if (
      usage?.inputTokens &&
      usage.inputTokens > (opts.compactAtTokens ?? 140_000) &&
      !ctx.signal.aborted
    ) {
      const summary = await summarize(opts, history)
      if (summary) {
        history = [{ role: 'user', content: summaryPrompt(summary) }]
        onEvent({ type: 'compacted', summary })
      }
    }
  }
  return {
    status: 'max-steps',
    steps: maxSteps,
    error: `已达到单次任务的最大步数（${maxSteps}），可以发送“继续”让它接着做。`,
  }
}

async function executeCall(
  call: { id: string; name: string; input: unknown },
  byName: Map<string, AgentTool<never>>,
  opts: RunAgentOptions,
  allowed: Set<string>,
): Promise<ToolResult> {
  const { ctx } = opts
  if (ctx.signal.aborted) return { output: ABORTED, isError: true }
  const tool = byName.get(call.name)
  if (!tool) return { output: `Unknown tool "${call.name}".`, isError: true }
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
    return { output: 'Tool input must be a JSON object.', isError: true }
  }
  const input = call.input as Record<string, unknown>
  const t = tool as AgentTool<Record<string, unknown>>

  let summary: string
  try {
    summary = t.describe(input)
  } catch {
    summary = call.name
  }

  if (opts.hooks) {
    const pre = await opts.hooks.run(
      'PreToolUse',
      { tool_name: call.name, tool_input: input },
      ctx.signal,
    )
    if (pre.block) return { output: `Blocked by a PreToolUse hook: ${pre.block}`, isError: true }
  }

  const decision = decide(tool, input, {
    cwd: ctx.cwd,
    mode: opts.mode,
    allowed,
    sandboxed: !!ctx.sandbox,
  })
  if (decision.action === 'ask') {
    const answer = await opts.approve({
      toolCallId: call.id,
      name: call.name,
      input,
      summary,
      reason: decision.reason,
      danger: decision.danger,
    })
    if (ctx.signal.aborted) return { output: ABORTED, isError: true }
    if (answer === 'deny') return { output: DENIED, isError: true }
    // Dangerous commands are never remembered: each one is confirmed on its own.
    if (answer === 'allow-always' && !decision.danger) allowed.add(allowKey(tool, input))
  }

  try {
    const result = await t.run(input, { ...ctx, toolCallId: call.id })
    if (opts.hooks) {
      const post = await opts.hooks.run(
        'PostToolUse',
        { tool_name: call.name, tool_input: input, tool_response: result.output },
        ctx.signal,
      )
      if (post.block)
        return {
          ...result,
          output: `${result.output}\n\nPostToolUse hook feedback:\n${post.block}`,
        }
    }
    return result
  } catch (err) {
    if (ctx.signal.aborted) return { output: ABORTED, isError: true }
    if (err instanceof ToolInputError)
      return { output: `Invalid input: ${err.message}`, isError: true }
    return { output: `Tool failed: ${errorMessage(err)}`, isError: true }
  }
}

const COMPACT_INSTRUCTIONS = `You are compacting a coding-agent session that is running out of context.
Write a concise but complete summary that lets the agent continue the task without the original messages:
1. The user's request(s), quoted verbatim.
2. Key decisions and constraints.
3. Files read or changed, with what changed.
4. Commands run and their important results (errors, test outcomes).
5. Current state, and the exact next steps.
Use the language the user writes in. Output only the summary.`

/** Ask the model for a summary of the history so far. Null if it fails. */
async function summarize(opts: RunAgentOptions, history: ModelMessage[]): Promise<string | null> {
  let text = ''
  for await (const e of streamChat({
    model: opts.model,
    system: COMPACT_INSTRUCTIONS,
    messages: [
      ...history,
      { role: 'user', content: 'Summarise the session so far as instructed.' },
    ],
    signal: opts.ctx.signal,
    maxOutputTokens: 4000,
  })) {
    if (e.type === 'text') text += e.text
    if (e.type === 'error') return null
  }
  return text.trim() || null
}
