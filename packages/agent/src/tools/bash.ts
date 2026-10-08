import { describeJob } from '../jobs'
import { looksSandboxBlocked } from '../sandbox'
import { runCommand, shellFor } from '../shell'
import { str, type AgentTool } from './types'

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000

export const bashTool: AgentTool<{
  command: string
  timeout_ms?: number
  unsandboxed?: boolean
  run_in_background?: boolean
}> = {
  kind: 'exec',
  get definition() {
    const shell = shellFor(process.platform).name
    return {
      name: 'bash',
      description:
        `Run a shell command (${shell}) in the project root and return its combined output and exit code. ` +
        'Each call starts a fresh shell in the project root, so use absolute or root-relative paths ' +
        '(`cd dir && cmd` works within one call). Commands are non-interactive: stdin is closed, so ' +
        'pass flags like --yes instead of waiting for prompts. ' +
        `Default timeout ${DEFAULT_TIMEOUT / 1000}s, max ${MAX_TIMEOUT / 1000}s. ` +
        'For dev servers, watchers and other long-running processes set run_in_background: it returns ' +
        'a job id at once; read its output with bash_output and stop it with kill_job.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number', description: `Timeout in ms (max ${MAX_TIMEOUT})` },
          run_in_background: {
            type: 'boolean',
            description: 'Start as a background job and return immediately (no timeout)',
          },
          unsandboxed: {
            type: 'boolean',
            description:
              'Run outside the sandbox (when one is active). Only after a command failed because ' +
              'of the sandbox; the user must approve it.',
          },
        },
        required: ['command'],
      },
    }
  },
  describe: (i) =>
    `${i.unsandboxed ? '在沙箱外' : ''}${i.run_in_background ? '后台运行' : '运行'} ${i.command}`,
  async run(input, ctx) {
    const command = str(input.command, 'command')
    const sandbox = !!ctx.sandbox && !input.unsandboxed
    if (input.run_in_background) {
      if (!ctx.jobs) return { output: 'Background jobs are not available here.', isError: true }
      const job = ctx.jobs.start(command, {
        cwd: ctx.cwd,
        env: ctx.env,
        platform: ctx.platform,
        sandbox,
      })
      // Give it a moment, so instant failures and startup lines come back right away
      // (`until` never matches: wait the full time unless the job exits).
      const first = await ctx.jobs.read(job, { waitMs: 1500, until: /(?!)/, signal: ctx.signal })
      return {
        output:
          `Started ${describeJob(job)}.\n` +
          (first.output.trim() ? `Output so far:\n${first.output.trimEnd()}\n` : '') +
          'Use bash_output to read more (it can wait for a line like "ready"), kill_job to stop it.',
        isError: !job.running && job.exitCode !== 0,
      }
    }
    const timeoutMs = Math.min(Math.max(1000, input.timeout_ms ?? DEFAULT_TIMEOUT), MAX_TIMEOUT)
    const res = await runCommand(command, {
      cwd: ctx.cwd,
      env: ctx.env,
      platform: ctx.platform,
      timeoutMs,
      signal: ctx.signal,
      sandbox,
    })
    const status = res.aborted
      ? 'Command was stopped by the user.'
      : res.timedOut
        ? `Command timed out after ${timeoutMs / 1000}s and was killed.`
        : `Exit code: ${res.exitCode}`
    const hint =
      sandbox && res.exitCode !== 0 && looksSandboxBlocked(res.output)
        ? '\nThis may have been blocked by the sandbox (it only allows writes inside the project, ' +
          'temp dirs and package caches). If the command really needs more, rerun it with ' +
          'unsandboxed: true; the user will be asked to approve.'
        : ''
    return {
      output: `${res.output.trimEnd() || '(no output)'}\n\n${status}${hint}`,
      isError: res.aborted || res.timedOut || res.exitCode !== 0,
    }
  },
}
