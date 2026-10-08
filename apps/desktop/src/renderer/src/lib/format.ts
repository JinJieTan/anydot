export function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString('zh-CN', sameYear ? { month: 'numeric', day: 'numeric' } : undefined)
}

export function formatTokens(n?: number): string {
  if (n === undefined) return '-'
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
}

/** Group label for the conversation list. */
export function dayGroup(ts: number): string {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const day = 86_400_000
  if (ts >= startOfToday.getTime()) return '今天'
  if (ts >= startOfToday.getTime() - day) return '昨天'
  if (ts >= startOfToday.getTime() - 7 * day) return '最近 7 天'
  if (ts >= startOfToday.getTime() - 30 * day) return '最近 30 天'
  return '更早'
}

export async function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

/** Best-effort MIME for files the OS reports without one. */
export function guessMime(file: File): string {
  if (file.type) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    md: 'text/markdown',
    ts: 'text/plain',
    tsx: 'text/plain',
    js: 'text/javascript',
    jsx: 'text/plain',
    py: 'text/x-python',
    go: 'text/plain',
    rs: 'text/plain',
    java: 'text/plain',
    c: 'text/plain',
    cpp: 'text/plain',
    h: 'text/plain',
    json: 'application/json',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    toml: 'application/toml',
    csv: 'text/csv',
    log: 'text/plain',
    sh: 'application/x-sh',
    sql: 'application/sql',
    pdf: 'application/pdf',
  }
  return map[ext] ?? 'text/plain'
}
