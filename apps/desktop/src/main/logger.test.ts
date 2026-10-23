import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Logger, redact } from './logger'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('logger', () => {
  it('redacts keys and tokens', () => {
    expect(redact('key sk-abcdefghijklmnop end')).toBe('key sk-*** end')
    expect(redact('Authorization: Bearer abc.def-ghijklmn')).toBe('Authorization: Bearer ***')
    expect(redact('{"apiKey":"secret123456"}')).toBe('{"apiKey":"***"}')
    expect(redact('plain text sk-short')).toBe('plain text sk-short')
  })

  it('appends lines and rotates past 5 MB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitech-log-'))
    dirs.push(dir)
    const log = new Logger(join(dir, 'logs'))
    log.write('error', 'main', ['boom', { apiKey: 'sk-0123456789abcdef' }])
    const text = readFileSync(log.file, 'utf8')
    expect(text).toMatch(/ERROR \[main\] boom/)
    expect(text).not.toContain('0123456789abcdef')

    writeFileSync(log.file, 'x'.repeat(5 * 1024 * 1024 + 1))
    log.write('info', 'main', ['after rotation'])
    expect(existsSync(join(dir, 'logs', 'main.old.log'))).toBe(true)
    expect(readFileSync(log.file, 'utf8')).toMatch(/INFO \[main\] after rotation\n$/)
  })
})
