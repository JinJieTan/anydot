import { isAbsolute, relative, resolve } from 'node:path'

/** Resolve a tool path against the project root and report whether it stays inside. */
export function resolvePath(cwd: string, p: string): { abs: string; inside: boolean; rel: string } {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p)
  const rel = relative(cwd, abs)
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  return { abs, inside, rel: rel || '.' }
}

/** Directories never worth walking. */
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  'release',
  'coverage',
])
