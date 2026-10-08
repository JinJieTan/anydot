import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bashTool,
  editFileTool,
  grepTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
} from './tools'
import type { ToolContext } from './tools/types'
import { htmlToText } from './tools/web'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aitech-agent-'))
  ctx = {
    cwd: dir,
    signal: new AbortController().signal,
    platform: process.platform,
    env: process.env,
    readFiles: new Map(),
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('file tools', () => {
  it('reads with line numbers and paging', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    const all = await readFileTool.run({ path: 'a.txt' }, ctx)
    expect(all.output).toMatch(/^1\tone\n2\ttwo\n3\tthree/)
    const page = await readFileTool.run({ path: 'a.txt', offset: 2, limit: 1 }, ctx)
    expect(page.output).toContain('2\ttwo')
    expect(page.output).toContain('continue with offset=3')
  })

  it('refuses binary and missing files', async () => {
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 1, 2]))
    expect((await readFileTool.run({ path: 'b.bin' }, ctx)).isError).toBe(true)
    expect((await readFileTool.run({ path: 'nope' }, ctx)).isError).toBe(true)
  })

  it('requires reading before overwriting, and detects external changes', async () => {
    writeFileSync(join(dir, 'c.txt'), 'old')
    await expect(writeFileTool.run({ path: 'c.txt', content: 'new' }, ctx)).rejects.toThrow(
      /Read c.txt/,
    )
    await readFileTool.run({ path: 'c.txt' }, ctx)
    await new Promise((r) => setTimeout(r, 15))
    writeFileSync(join(dir, 'c.txt'), 'changed elsewhere')
    await expect(writeFileTool.run({ path: 'c.txt', content: 'new' }, ctx)).rejects.toThrow(
      /changed on disk/,
    )
  })

  it('creates new files and directories without a prior read', async () => {
    const res = await writeFileTool.run({ path: 'src/new/file.ts', content: 'x\ny' }, ctx)
    expect(res.output).toMatch(/Created src[/\\]new[/\\]file.ts \(2 lines\)/)
    expect(readFileSync(join(dir, 'src/new/file.ts'), 'utf8')).toBe('x\ny')
  })

  it('edits uniquely, supports replace_all, preserves CRLF', async () => {
    writeFileSync(join(dir, 'd.txt'), 'a\r\nb\r\na\r\n')
    await readFileTool.run({ path: 'd.txt' }, ctx)
    const ambiguous = await editFileTool.run(
      { path: 'd.txt', old_string: 'a', new_string: 'z' },
      ctx,
    )
    expect(ambiguous).toMatchObject({ isError: true })
    expect(ambiguous.output).toMatch(/2 times/)
    await editFileTool.run({ path: 'd.txt', old_string: 'a\nb', new_string: 'x\ny' }, ctx)
    expect(readFileSync(join(dir, 'd.txt'), 'utf8')).toBe('x\r\ny\r\na\r\n')
    await editFileTool.run(
      { path: 'd.txt', old_string: 'a', new_string: 'q', replace_all: true },
      ctx,
    )
    expect(readFileSync(join(dir, 'd.txt'), 'utf8')).toBe('x\r\ny\r\nq\r\n')
  })

  it('handles $ patterns in replacement text literally', async () => {
    writeFileSync(join(dir, 'e.js'), 'const a = 1')
    await readFileTool.run({ path: 'e.js' }, ctx)
    await editFileTool.run({ path: 'e.js', old_string: '1', new_string: "'$&$1'" }, ctx)
    expect(readFileSync(join(dir, 'e.js'), 'utf8')).toBe("const a = '$&$1'")
  })

  it('lists and greps, skipping node_modules', async () => {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(dir, 'src/main.ts'), 'export const hello = 1\n')
    writeFileSync(join(dir, 'src/util.js'), 'hello()\n')
    writeFileSync(join(dir, 'node_modules/pkg/index.ts'), 'hello\n')

    const ts = await listFilesTool.run({ pattern: '**/*.ts' }, ctx)
    expect(ts.output).toBe('src/main.ts')

    const hits = await grepTool.run({ pattern: 'hello' }, ctx)
    expect(hits.output.split('\n').sort()).toEqual([
      'src/main.ts:1: export const hello = 1',
      'src/util.js:1: hello()',
    ])

    const onlyJs = await grepTool.run({ pattern: 'HELLO', glob: '*.js', ignore_case: true }, ctx)
    expect(onlyJs.output).toBe('src/util.js:1: hello()')
  })
})

describe('undo backups', () => {
  it('records the previous content of edited and overwritten files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    await readFileTool.run({ path: 'a.txt' }, ctx)
    const edit = await editFileTool.run(
      { path: 'a.txt', old_string: 'one', new_string: 'two' },
      ctx,
    )
    expect(edit.backups).toEqual([
      { path: join(dir, 'a.txt'), data: new TextEncoder().encode('one\n') },
    ])
    const write = await writeFileTool.run({ path: 'a.txt', content: 'three' }, ctx)
    expect(new TextDecoder().decode(write.backups![0]!.data!)).toBe('two\n')
  })

  it('records that a new file did not exist', async () => {
    const r = await writeFileTool.run({ path: 'new/b.txt', content: 'x' }, ctx)
    expect(r.backups).toEqual([{ path: join(dir, 'new', 'b.txt'), data: null }])
  })
})

describe('bash', () => {
  it('runs in the project root and reports exit codes', async () => {
    const ok = await bashTool.run(
      { command: process.platform === 'win32' ? 'Get-Location' : 'pwd' },
      ctx,
    )
    expect(ok.output).toContain(dir.split(/[\\/]/).pop())
    expect(ok.output).toMatch(/Exit code: 0$/)
    const bad = await bashTool.run({ command: 'exit 3' }, ctx)
    expect(bad).toMatchObject({ isError: true })
    expect(bad.output).toMatch(/Exit code: 3$/)
    // PowerShell takes seconds to start on CI runners.
  }, 30_000)

  it.skipIf(process.platform === 'win32')('times out and kills the process', async () => {
    const started = Date.now()
    const res = await bashTool.run({ command: 'sleep 30', timeout_ms: 1000 }, ctx)
    expect(res.output).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it.skipIf(process.platform === 'win32')('stops when aborted', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const res = await bashTool.run({ command: 'sleep 30' }, { ...ctx, signal: controller.signal })
    expect(res.output).toMatch(/stopped by the user/)
  })
})

describe('htmlToText', () => {
  it('strips markup and scripts', () => {
    expect(
      htmlToText(
        '<html><head><title>x</title></head><body><script>bad()</script><h1>Hi &amp; bye</h1><p>a<br>b</p></body></html>',
      ),
    ).toBe('Hi & bye\na\nb')
  })
})
