import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, matchesGlob, relative } from 'node:path'
import { IGNORED_DIRS, resolvePath } from '../paths'
import { str, ToolInputError, type AgentTool, type FileBackup, type ToolContext } from './types'

const MAX_READ_BYTES = 5 * 1024 * 1024
const DEFAULT_LINES = 2000
const MAX_LINE = 2000

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

/** Refuse to overwrite a file the agent hasn't seen, or that changed since it read it. */
async function assertFresh(abs: string, rel: string, ctx: ToolContext) {
  const mtime = await mtimeOf(abs)
  if (mtime === null) return // new file
  const seen = ctx.readFiles.get(abs)
  if (seen === undefined)
    throw new ToolInputError(`Read ${rel} with read_file before modifying it.`)
  if (seen !== mtime) {
    throw new ToolInputError(
      `${rel} changed on disk since it was read. Read it again before modifying it.`,
    )
  }
}

export const readFileTool: AgentTool<{ path: string; offset?: number; limit?: number }> = {
  kind: 'read',
  definition: {
    name: 'read_file',
    description:
      'Read a text file. Returns numbered lines (cat -n style). Use offset/limit for large files. ' +
      'Always read a file before editing or overwriting it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path, relative to the project root or absolute',
        },
        offset: { type: 'number', description: '1-based line to start from' },
        limit: { type: 'number', description: `Max lines to return (default ${DEFAULT_LINES})` },
      },
      required: ['path'],
    },
  },
  describe: (i) => `读取 ${i.path}`,
  paths: (i) => [i.path],
  async run(input, ctx) {
    const { abs, rel } = resolvePath(ctx.cwd, str(input.path, 'path'))
    const info = await stat(abs).catch(() => null)
    if (!info) return { output: `File not found: ${rel}`, isError: true }
    if (info.isDirectory())
      return { output: `${rel} is a directory; use list_files.`, isError: true }
    if (info.size > MAX_READ_BYTES)
      return { output: `${rel} is too large (${info.size} bytes).`, isError: true }
    const buf = await readFile(abs)
    if (isBinary(buf)) return { output: `${rel} looks like a binary file.`, isError: true }
    ctx.readFiles.set(abs, info.mtimeMs)

    const lines = buf.toString('utf8').split(/\r?\n/)
    const start = Math.max(1, Math.floor(input.offset ?? 1))
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LINES))
    const slice = lines.slice(start - 1, start - 1 + limit)
    const width = String(start + slice.length).length
    const body = slice
      .map((l, i) => {
        const line = l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l
        return `${String(start + i).padStart(width)}\t${line}`
      })
      .join('\n')
    const more = start - 1 + slice.length < lines.length
    return {
      output:
        (body || '(empty file)') +
        (more
          ? `\n\n[${lines.length} lines total; continue with offset=${start + slice.length}]`
          : ''),
    }
  },
}

/** Files larger than this aren't backed up (undo then leaves them alone). */
const MAX_BACKUP = 5 * 1024 * 1024

/** The file's current content, for undo; undefined if it is too large to keep. */
export async function backupOf(abs: string): Promise<FileBackup | undefined> {
  try {
    const st = await stat(abs)
    if (!st.isFile() || st.size > MAX_BACKUP) return undefined
    return { path: abs, data: new Uint8Array(await readFile(abs)) }
  } catch {
    return { path: abs, data: null }
  }
}

export const writeFileTool: AgentTool<{ path: string; content: string }> = {
  kind: 'write',
  definition: {
    name: 'write_file',
    description:
      'Create a new file or completely overwrite an existing one. Prefer edit_file for changes to ' +
      'existing files. Existing files must be read first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  describe: (i) => `写入 ${i.path}`,
  paths: (i) => [i.path],
  async run(input, ctx) {
    const { abs, rel } = resolvePath(ctx.cwd, str(input.path, 'path'))
    if (typeof input.content !== 'string') throw new ToolInputError('"content" must be a string')
    await assertFresh(abs, rel, ctx)
    const existed = (await mtimeOf(abs)) !== null
    const backup = await backupOf(abs)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf8')
    ctx.readFiles.set(abs, (await stat(abs)).mtimeMs)
    const n = input.content.split('\n').length
    return {
      output: `${existed ? 'Overwrote' : 'Created'} ${rel} (${n} lines).`,
      backups: backup && [backup],
    }
  },
}

export const editFileTool: AgentTool<{
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}> = {
  kind: 'write',
  definition: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match the file exactly (including ' +
      'indentation) and be unique unless replace_all is true. Read the file first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  describe: (i) => `编辑 ${i.path}`,
  paths: (i) => [i.path],
  async run(input, ctx) {
    const { abs, rel } = resolvePath(ctx.cwd, str(input.path, 'path'))
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
      throw new ToolInputError('"old_string" and "new_string" must be strings')
    }
    if (input.old_string === input.new_string)
      throw new ToolInputError('old_string and new_string are identical')
    if ((await mtimeOf(abs)) === null) return { output: `File not found: ${rel}`, isError: true }
    await assertFresh(abs, rel, ctx)

    const original = await readFile(abs, 'utf8')
    // Models write \n; keep the file's own line endings (CRLF on many Windows repos).
    const crlf = original.includes('\r\n')
    const norm = (s: string) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s)
    const oldStr = norm(input.old_string)
    const newStr = norm(input.new_string)

    const count = oldStr ? original.split(oldStr).length - 1 : 0
    if (count === 0)
      return {
        output: `old_string not found in ${rel}. Read the file and copy the text exactly.`,
        isError: true,
      }
    if (count > 1 && !input.replace_all) {
      return {
        output: `old_string occurs ${count} times in ${rel}. Add surrounding context to make it unique, or set replace_all.`,
        isError: true,
      }
    }
    const updated = input.replace_all
      ? original.split(oldStr).join(newStr)
      : original.replace(oldStr, () => newStr)
    const backup = await backupOf(abs)
    await writeFile(abs, updated, 'utf8')
    ctx.readFiles.set(abs, (await stat(abs)).mtimeMs)
    return {
      output: `Edited ${rel}: ${input.replace_all ? `${count} replacements` : '1 replacement'}.`,
      backups: backup && [backup],
    }
  },
}

/** Walk the tree below `root`, skipping ignored directories. */
async function* walk(root: string, signal: AbortSignal): AsyncGenerator<string> {
  const stack = [root]
  while (stack.length) {
    if (signal.aborted) return
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(full)
      } else if (e.isFile()) {
        yield full
      }
    }
  }
}

const toPosix = (p: string) => p.split('\\').join('/')

export const listFilesTool: AgentTool<{ pattern?: string; path?: string }> = {
  kind: 'read',
  definition: {
    name: 'list_files',
    description:
      'Find files by glob pattern (e.g. "src/**/*.ts", "**/package.json"). Skips node_modules, .git ' +
      'and build output. Without a pattern, lists files under path.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern relative to path' },
        path: { type: 'string', description: 'Directory to search (default: project root)' },
      },
    },
  },
  describe: (i) => `查找文件 ${i.pattern ?? i.path ?? '.'}`,
  paths: (i) => [i.path ?? '.'],
  async run(input, ctx) {
    const { abs, rel } = resolvePath(ctx.cwd, input.path ?? '.')
    const pattern = input.pattern ?? '**/*'
    const LIMIT = 300
    const hits: { path: string; mtime: number }[] = []
    let more = false
    for await (const file of walk(abs, ctx.signal)) {
      const relToRoot = toPosix(relative(abs, file))
      if (!matchesGlob(relToRoot, pattern) && !matchesGlob(relToRoot, `**/${pattern}`)) continue
      if (hits.length >= LIMIT) {
        more = true
        break
      }
      hits.push({ path: toPosix(relative(ctx.cwd, file)), mtime: (await mtimeOf(file)) ?? 0 })
    }
    if (!hits.length) return { output: `No files matching "${pattern}" under ${rel}.` }
    hits.sort((a, b) => b.mtime - a.mtime)
    return {
      output:
        hits.map((h) => h.path).join('\n') +
        (more ? `\n\n[more than ${LIMIT} matches; narrow the pattern]` : ''),
    }
  },
}

export const grepTool: AgentTool<{
  pattern: string
  path?: string
  glob?: string
  ignore_case?: boolean
}> = {
  kind: 'read',
  definition: {
    name: 'grep',
    description:
      'Search file contents with a regular expression (JavaScript syntax). Returns file:line: text. ' +
      'Use glob to restrict files, e.g. "*.ts".',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory or file (default: project root)' },
        glob: { type: 'string', description: 'Only search files matching this glob' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  describe: (i) => `搜索 "${i.pattern}"`,
  paths: (i) => [i.path ?? '.'],
  async run(input, ctx) {
    let re: RegExp
    try {
      re = new RegExp(str(input.pattern, 'pattern'), input.ignore_case ? 'i' : '')
    } catch (err) {
      return { output: `Invalid regex: ${(err as Error).message}`, isError: true }
    }
    const { abs } = resolvePath(ctx.cwd, input.path ?? '.')
    const info = await stat(abs).catch(() => null)
    if (!info) return { output: `Path not found: ${input.path}`, isError: true }

    const LIMIT = 200
    const out: string[] = []
    const files = info.isFile() ? [abs] : walk(abs, ctx.signal)
    for await (const file of files) {
      const relPath = toPosix(relative(ctx.cwd, file))
      if (input.glob && !matchesGlob(toPosix(relative(abs, file)) || relPath, `**/${input.glob}`))
        continue
      const fstat = await stat(file).catch(() => null)
      if (!fstat || fstat.size > 1024 * 1024) continue
      const buf = await readFile(file).catch(() => null)
      if (!buf || isBinary(buf)) continue
      const lines = buf.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          out.push(`${relPath}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`)
          if (out.length >= LIMIT) {
            return {
              output: `${out.join('\n')}\n\n[stopped at ${LIMIT} matches; narrow the search]`,
            }
          }
        }
      }
    }
    return { output: out.length ? out.join('\n') : 'No matches.' }
  },
}
