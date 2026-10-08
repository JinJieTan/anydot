import { describe, expect, it } from 'vitest'
import { JobManager } from './jobs'
import { bashOutputTool, bashTool, killJobTool } from './tools'
import type { ToolContext } from './tools/types'

const isWin = process.platform === 'win32'

function ctx(jobs: JobManager, scope = 'conv1'): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    platform: process.platform,
    env: process.env,
    readFiles: new Map(),
    jobs: jobs.scope(scope),
  }
}

// A tiny "server": prints a few lines, then announces it is ready and keeps running.
const server = `node -e "let i=0;const t=setInterval(()=>{console.log('tick '+ ++i);if(i===3)console.log('ready on 4000')},100)"`

describe.skipIf(isWin)('background jobs', () => {
  it('starts, streams output, waits for a pattern and stops', async () => {
    const jobs = new JobManager()
    const c = ctx(jobs)
    const started = await bashTool.run({ command: server, run_in_background: true }, c)
    expect(started.output).toMatch(/Started job1: .* \(running for \d+s\)/)

    // "ready" was already printed during the start-up read; waiting for it still succeeds.
    const ready = await bashOutputTool.run({ job_id: 'job1', until: 'ready on \\d+' }, c)
    expect(ready.output).not.toContain('no match')

    // Only new output the second time.
    const more = (await bashOutputTool.run({ job_id: 'job1', wait_ms: 500 }, c)).output
    const body = more.slice(more.indexOf('\n\n'))
    expect(body).not.toContain('ready on 4000')
    expect(body).toMatch(/tick \d+/)

    expect((await bashOutputTool.run({}, c)).output).toMatch(/job1: .*running/)
    expect((await killJobTool.run({ job_id: 'job1' }, c)).output).toBe('Stopped job1.')
    expect((await bashOutputTool.run({}, c)).output).toMatch(/job1: .*exited/)
  })

  it('keeps jobs per conversation and clears them', async () => {
    const jobs = new JobManager()
    await bashTool.run({ command: server, run_in_background: true }, ctx(jobs, 'a'))
    expect((await bashOutputTool.run({}, ctx(jobs, 'b'))).output).toBe('No background jobs.')
    const job = jobs.scope('a').list()[0]!
    jobs.clear('a')
    await new Promise((r) => setTimeout(r, 300))
    expect(job.running).toBe(false)
  })

  it('reports a job that fails at once', async () => {
    const jobs = new JobManager()
    const r = await bashTool.run(
      { command: 'echo boom >&2; exit 3', run_in_background: true },
      ctx(jobs),
    )
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/exited with code 3/)
    expect(r.output).toContain('boom')
  })
})
