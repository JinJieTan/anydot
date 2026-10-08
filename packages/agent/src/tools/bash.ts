import { runCommand, shellFor } from '../shell'
import { str, type AgentTool } from './types'

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000

export const bashTool: AgentTool<{ command: string; timeout_ms?: number }> = {
  kind: 'exec',
  get definition() {
    const shell = shellFor(process.platform).name
    return {
      name: 'bash',
      description:
        `Run a shell command (${shell}) in the project root and return its combined output and exit code. ` +
        'Each call starts a fresh shell in the project root, so use absolute or root-relative paths ' +
        '(`cd dir && cmd` works within one call). Commands are non-interactive: stdin is closed, so ' +
        'pass flags like --yes instead of waiting for prompts. Do not start long-running servers; ' +
        `default timeout ${DEFAULT_TIMEOUT / 1000}s, max ${MAX_TIMEOUT / 1000}s.`,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number', description: `Timeout in ms (max ${MAX_TIMEOUT})` },
        },
        required: ['command'],
      },
    }
  },
  describe: (i) => `运行 ${i.command}`,
  async run(input, ctx) {
    const command = str(input.command, 'command')
    const timeoutMs = Math.min(Math.max(1000, input.timeout_ms ?? DEFAULT_TIMEOUT), MAX_TIMEOUT)
    const res = await runCommand(command, {
      cwd: ctx.cwd,
      env: ctx.env,
      platform: ctx.platform,
      timeoutMs,
      signal: ctx.signal,
    })
    const status = res.aborted
      ? 'Command was stopped by the user.'
      : res.timedOut
        ? `Command timed out after ${timeoutMs / 1000}s and was killed.`
        : `Exit code: ${res.exitCode}`
    return {
      output: `${res.output.trimEnd() || '(no output)'}\n\n${status}`,
      isError: res.aborted || res.timedOut || res.exitCode !== 0,
    }
  },
}
