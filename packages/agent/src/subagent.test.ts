import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockServer, type MockServer } from '@aitech/core/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAgent, type AgentEvent, type ApprovalRequest } from './loop'
import { createSubagent } from './subagent'
import { ALL_TOOLS } from './tools'
import type { ToolContext } from './tools/types'

let server: MockServer
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aitech-sub-'))
  writeFileSync(join(dir, 'notes.txt'), 'the answer is 42\n')
  // Parent: start two sub-agents, then report. Sub-agent: read a file, then report.
  server = await startMockServer({
    reply: (r) => {
      const body = r.body as { system?: unknown; instructions?: string }
      const system = JSON.stringify(body.system ?? body.instructions ?? '')
      const n = r.toolResults.length
      if (system.includes('sub-agent')) {
        if (n === 0) return { toolCalls: [{ name: 'read_file', input: { path: 'notes.txt' } }] }
        return { text: `Report: ${r.toolResults.at(-1)}` }
      }
      if (n === 0)
        return {
          toolCalls: [
            { name: 'task', input: { description: 'find answer', prompt: 'What is the answer?' } },
            { name: 'task', input: { description: 'again', prompt: 'Find it again' } },
          ],
        }
      return { text: `Parent got ${n} reports` }
    },
  })
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('task tool', () => {
  it('runs read-only sub-agents in parallel and returns their reports', async () => {
    const model = {
      provider: { baseUrl: server.url, apiKey: 'sk-test', type: 'auto' as const },
      modelId: 'claude-sonnet-5-5',
    }
    const ctx: ToolContext = {
      cwd: dir,
      signal: new AbortController().signal,
      platform: process.platform,
      env: process.env,
      readFiles: new Map(),
    }
    const approvals: ApprovalRequest[] = []
    const approve = async (r: ApprovalRequest) => {
      approvals.push(r)
      return 'allow' as const
    }
    ctx.subagent = createSubagent({
      model,
      system: 'You are a sub-agent of AnyDot.',
      tools: ALL_TOOLS,
      ctx,
      mode: 'ask',
      allowed: new Set(),
      approve,
    })
    const events: AgentEvent[] = []
    const res = await runAgent({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: ALL_TOOLS,
      ctx,
      mode: 'ask',
      onEvent: (e) => events.push(e),
      approve,
    })
    expect(res.status).toBe('done')
    const results = events.filter((e) => e.type === 'tool-result')
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.name).toBe('task')
      expect(r.output).toContain('the answer is 42')
      expect(r.isError).toBe(false)
    }
    // Reads inside the project need no approval; the parent never saw the sub-agent's tool calls.
    expect(approvals).toEqual([])
    expect(events.filter((e) => e.type === 'step-start')).toHaveLength(2)
  })
})
