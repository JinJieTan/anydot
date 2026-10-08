import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { windowsLauncher, windowsSandboxSpawn } from './sandbox-windows'

/**
 * OS sandbox for agent commands (macOS Seatbelt, as Codex and Claude Code
 * use). A sandboxed command can read most things and use the network, but
 * may only write inside the project, temp dirs and package-manager caches,
 * and can't read SSH / cloud credentials. On Windows an experimental
 * write-only equivalent is used (see sandbox-windows.ts).
 */

const SEATBELT = '/usr/bin/sandbox-exec'

/** Under $HOME: caches that package managers and build tools write to. */
const WRITABLE_HOME = [
  '.npm',
  '.pnpm-store',
  'Library/pnpm',
  '.local/share/pnpm',
  '.yarn',
  '.bun',
  '.deno',
  '.cache',
  'Library/Caches',
  '.cargo/registry',
  '.cargo/git',
  'go/pkg',
  '.gradle',
  '.m2',
  '.node-gyp',
  '.electron-gyp',
  'Library/Developer/Xcode/DerivedData',
]

/** Under $HOME: secrets a command has no business reading. */
const HIDDEN_HOME = ['.ssh', '.aws', '.gnupg', '.kube', '.docker/config.json', '.netrc']

export function sandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return existsSync(SEATBELT)
  if (platform === 'win32') return windowsLauncher() !== null
  return false
}

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** SBPL string literal. */
const lit = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function seatbeltProfile(opts: { cwd: string; home?: string; extraWritable?: string[] }) {
  const home = real(opts.home ?? homedir())
  const cwd = real(opts.cwd)
  const writable = [
    cwd,
    real(tmpdir()),
    '/private/tmp',
    '/private/var/folders',
    ...WRITABLE_HOME.map((p) => `${home}/${p}`),
    ...(opts.extraWritable ?? []).map(real),
  ]
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...writable.map((p) => `  (subpath ${lit(p)})`),
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/") (literal "/dev/ptmx") (regex #"^/dev/ttys"))',
    // Git hooks and config run later outside the sandbox (e.g. when the user
    // commits), so writing them would be a way out.
    `(deny file-write* (subpath ${lit(`${cwd}/.git/hooks`)}) (literal ${lit(`${cwd}/.git/config`)}))`,
    `(deny file-read* file-write*`,
    ...HIDDEN_HOME.map((p) => `  (subpath ${lit(`${home}/${p}`)})`),
    ')',
  ].join('\n')
}

/** Wrap a spawn so it runs inside the sandbox. */
export function sandboxSpawn(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform },
): { file: string; args: string[] } {
  if (opts.platform === 'win32') return windowsSandboxSpawn(file, args, opts)
  const profile = seatbeltProfile({ cwd: opts.cwd, home: opts.env.HOME })
  return { file: SEATBELT, args: ['-p', profile, file, ...args] }
}

/** Output that suggests the sandbox, not the command, is what failed. */
export function looksSandboxBlocked(output: string): boolean {
  return /operation not permitted|EPERM|access (to the path .* )?is denied|UnauthorizedAccess|sandbox/i.test(
    output,
  )
}
