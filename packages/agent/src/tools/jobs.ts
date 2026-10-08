import { describeJob } from '../jobs'
import { str, ToolInputError, type AgentTool } from './types'

export const bashOutputTool: AgentTool<{ job_id?: string; wait_ms?: number; until?: string }> = {
  kind: 'read',
  definition: {
    name: 'bash_output',
    description:
      'Read new output from a background job started with bash run_in_background. Without job_id, ' +
      'lists the jobs. Set until (a regex, e.g. "ready|listening on") with wait_ms to wait for a ' +
      'server to come up.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        wait_ms: {
          type: 'number',
          description: 'Wait up to this long for new output (or for `until` to match), max 60000',
        },
        until: { type: 'string', description: 'Regex to wait for in the new output' },
      },
    },
  },
  describe: (i) => (i.job_id ? `读取后台任务 ${i.job_id} 的输出` : '查看后台任务'),
  async run(input, ctx) {
    if (!ctx.jobs) return { output: 'Background jobs are not available here.', isError: true }
    if (!input.job_id) {
      const jobs = ctx.jobs.list()
      return { output: jobs.length ? jobs.map(describeJob).join('\n') : 'No background jobs.' }
    }
    const job = ctx.jobs.get(input.job_id)
    if (!job) return { output: `No job "${input.job_id}".`, isError: true }
    let until: RegExp | undefined
    if (input.until) {
      try {
        until = new RegExp(input.until, 'i')
      } catch {
        throw new ToolInputError(`invalid regex: ${input.until}`)
      }
    }
    const waitMs = Math.max(0, Math.min(60_000, input.wait_ms ?? (until ? 30_000 : 0)))
    const { output, matched } = await ctx.jobs.read(job, { waitMs, until, signal: ctx.signal })
    const note = until && !matched && job.running ? `\n(no match for /${input.until}/ yet)` : ''
    return {
      output: `${describeJob(job)}\n\n${output.trimEnd() || '(no new output)'}${note}`,
      isError: !job.running && job.exitCode !== 0,
    }
  },
}

export const killJobTool: AgentTool<{ job_id: string }> = {
  kind: 'meta',
  definition: {
    name: 'kill_job',
    description: 'Stop a background job (and everything it started).',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  describe: (i) => `停止后台任务 ${i.job_id}`,
  async run(input, ctx) {
    const job = ctx.jobs?.get(str(input.job_id, 'job_id'))
    if (!job) return { output: `No job "${input.job_id}".`, isError: true }
    if (!job.running) return { output: `${describeJob(job)}; nothing to stop.` }
    job.kill()
    await ctx.jobs!.read(job, { waitMs: 3000 })
    return { output: `Stopped ${job.id}.` }
  },
}
