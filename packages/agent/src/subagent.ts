import type { ModelRef, ThinkingLevel } from '@aitech/core'
import { runAgent, type ApprovalDecision, type ApprovalRequest } from './loop'
import { toolsForMode, type PermissionMode } from './permissions'
import type { AgentTool, ToolContext, ToolResult } from './tools/types'

/** Tools a sub-agent never gets: no nesting, and its todo list and questions would have nowhere to show. */
const EXCLUDED = new Set(['task', 'todo_write', 'ask_user'])

/**
 * The task tool's runner: a fresh, read-only agent loop on the same model.
 * Its approvals surface on the parent's task call; only its final text comes back.
 */
export function createSubagent(base: {
  model: ModelRef
  system: string
  thinking?: ThinkingLevel
  /** The parent's tools; narrowed to the read-only set. */
  tools: AgentTool<never>[]
  ctx: ToolContext
  /** The parent's mode: decides which reads/fetches still need approval. */
  mode: PermissionMode
  allowed: Set<string>
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>
  maxSteps?: number
}): (prompt: string, parentCallId?: string) => Promise<ToolResult> {
  const tools = toolsForMode(base.tools, 'plan').filter((t) => !EXCLUDED.has(t.definition.name))
  return async (prompt, parentCallId) => {
    let text = ''
    let steps = 0
    const result = await runAgent({
      model: base.model,
      system: base.system,
      thinking: base.thinking,
      messages: [{ role: 'user', content: prompt }],
      tools,
      ctx: { ...base.ctx, readFiles: new Map(), subagent: undefined },
      mode: base.mode,
      allowed: base.allowed,
      maxSteps: base.maxSteps ?? 40,
      onEvent: (e) => {
        // The report is the text of the last step.
        if (e.type === 'step-start') {
          text = ''
          steps++
        }
        if (e.type === 'text') text += e.text
      },
      approve: (req) =>
        base.approve({
          ...req,
          toolCallId: parentCallId ?? req.toolCallId,
          summary: `子任务 · ${req.summary}`,
          reason: `${req.reason}（子任务：${req.summary}）`,
        }),
    })
    const report = text.trim()
    if (result.status === 'done' && report) return { output: report }
    const why =
      result.status === 'aborted'
        ? 'The sub-agent was stopped.'
        : result.status === 'max-steps'
          ? `The sub-agent ran out of steps (${steps}).`
          : `The sub-agent failed: ${result.error ?? 'no report'}`
    return { output: report ? `${why}\nPartial report:\n${report}` : why, isError: !report }
  }
}
