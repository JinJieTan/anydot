import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

const MAX_BYTES = 5 * 1024 * 1024

/** Things that look like API keys or bearer tokens never reach the log file. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|xai|gsk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(
      /("?(?:api[_-]?key|apiKey|x-api-key|authorization)"?\s*[:=]\s*"?)(?!Bearer\b)[^"\s,}]{6,}/gi,
      '$1***',
    )
}

/**
 * Plain-text log in `dir/main.log`, rotated to `main.old.log` past 5 MB. Writes
 * are synchronous so the last lines before a crash make it to disk.
 */
export class Logger {
  readonly file: string

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'main.log')
  }

  write(level: 'info' | 'warn' | 'error', source: string, args: unknown[]): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${source}] ${redact(format(...args))}\n`
    try {
      if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES)
        renameSync(this.file, join(this.dir, 'main.old.log'))
      appendFileSync(this.file, line)
    } catch {
      // Logging must never take the app down.
    }
  }

  /** Mirror console.warn / console.error (and info-level console.log) into the file. */
  captureConsole(): void {
    for (const [method, level] of [
      ['log', 'info'],
      ['info', 'info'],
      ['warn', 'warn'],
      ['error', 'error'],
    ] as const) {
      const original = console[method].bind(console)
      console[method] = (...args: unknown[]) => {
        original(...args)
        this.write(level, 'main', args)
      }
    }
  }
}
