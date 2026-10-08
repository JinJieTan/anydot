import { spawn } from 'node:child_process'

export interface ShellInfo {
  /** Executable used to run commands. */
  shell: string
  /** Arguments placed before the command string. */
  args: string[]
  /** Human name for prompts: "zsh", "bash", "PowerShell". */
  name: string
}

export function shellFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellInfo {
  if (platform === 'win32') {
    return {
      shell: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      name: 'PowerShell',
    }
  }
  const shell = env.SHELL || '/bin/bash'
  return { shell, args: ['-c'], name: shell.split('/').pop() ?? 'sh' }
}

/**
 * Apps launched from the Dock / Start menu get a minimal PATH, so tools
 * installed via nvm, Homebrew, pyenv etc. are missing. Ask the user's login
 * shell for its environment once, as VS Code does. Falls back to process.env.
 */
export async function resolveShellEnv(timeoutMs = 5000): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return { ...process.env }
  const shell = process.env.SHELL || '/bin/bash'
  const mark = `__AITECH_ENV_${Date.now()}__`
  return new Promise((resolve) => {
    const child = spawn(shell, ['-ilc', `echo ${mark}; env; echo ${mark}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
      detached: true,
    })
    let out = ''
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
      resolve({ ...process.env })
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ...process.env })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const parts = out.split(mark)
      if (parts.length < 3) return resolve({ ...process.env })
      const env: NodeJS.ProcessEnv = {}
      for (const line of parts[1]!.split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
      }
      resolve({ ...process.env, ...env })
    })
  })
}

export interface RunResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  aborted: boolean
}

const MAX_OUTPUT = 30_000

/** Keep the head and tail of long output; the end usually has the error. */
export function truncateOutput(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.3)
  const tail = max - head
  return `${text.slice(0, head)}\n\n…[${text.length - max} characters omitted]…\n\n${text.slice(-tail)}`
}

/** Run a shell command, killing the whole process tree on timeout or abort. */
export function runCommand(
  command: string,
  opts: {
    cwd: string
    env: NodeJS.ProcessEnv
    platform: NodeJS.Platform
    timeoutMs: number
    signal: AbortSignal
  },
): Promise<RunResult> {
  const { shell, args } = shellFor(opts.platform, opts.env)
  return new Promise((resolve) => {
    const child = spawn(shell, [...args, command], {
      cwd: opts.cwd,
      env: {
        ...opts.env,
        // Never block on pagers or prompts; keep output plain.
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        TERM: 'dumb',
        NO_COLOR: '1',
        CI: opts.env.CI ?? '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: opts.platform !== 'win32',
      windowsHide: true,
    })

    let output = ''
    let timedOut = false
    let aborted = false
    const onData = (d: Buffer) => {
      output += d.toString('utf8')
      // Bound memory for runaway output; truncation happens again at the end.
      if (output.length > MAX_OUTPUT * 4) output = truncateOutput(output, MAX_OUTPUT * 2)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    const kill = () => {
      if (child.exitCode !== null || !child.pid) return
      if (opts.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM')
          setTimeout(() => {
            try {
              process.kill(-child.pid!, 'SIGKILL')
            } catch {
              // exited
            }
          }, 2000)
        } catch {
          // exited
        }
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs)
    const onAbort = () => {
      aborted = true
      kill()
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    const finish = (exitCode: number | null) => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      resolve({ exitCode, output: truncateOutput(output), timedOut, aborted })
    }
    child.on('error', (err) => {
      output += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}
