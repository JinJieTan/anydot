/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week),
 * evaluated in local time. Supports *, lists, ranges and steps (e.g.
 * "0 9 * * 1-5", "*\/15 * * * *"). As in standard cron, when both day fields
 * are restricted a time matches if either does.
 */
interface Cron {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domAny: boolean
  dowAny: boolean
}

const FIELDS: [string, number, number][] = [
  ['分钟', 0, 59],
  ['小时', 0, 23],
  ['日期', 1, 31],
  ['月份', 1, 12],
  ['星期', 0, 7],
]

function field(text: string, [label, min, max]: [string, number, number]): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new Error(`无效的${label}：${part}`)
    const step = m[4] ? Number(m[4]) : 1
    let lo = min
    let hi = max
    if (m[2] !== undefined) {
      lo = Number(m[2])
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo
    }
    if (step < 1 || lo < min || hi > max || lo > hi) throw new Error(`${label}超出范围：${part}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('定时规则需要 5 个字段：分 时 日 月 周')
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]!))
  if (dow!.has(7)) dow!.add(0)
  return {
    minute: minute!,
    hour: hour!,
    dom: dom!,
    month: month!,
    dow: dow!,
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  }
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate())
  const dow = c.dow.has(d.getDay())
  if (c.domAny || c.dowAny) return dom && dow
  return dom || dow
}

/** The first matching minute strictly after `after`; null if none within ~5 years. */
export function nextRun(expr: string, after: number): number | null {
  const c = parseCron(expr)
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = after + 5 * 366 * 86_400_000
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
    } else {
      return d.getTime()
    }
  }
  return null
}
