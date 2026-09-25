/** Period presets. All periods are UTC and half-open: [start, end) in unix seconds. */

export type PresetId = 'this-month' | 'last-month' | 'this-quarter' | 'last-quarter' | 'this-year' | 'last-year' | 'custom'

export interface Period {
  start: number
  end: number
}

export const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'last-month', label: 'Last month' },
  { id: 'this-month', label: 'This month' },
  { id: 'last-quarter', label: 'Last quarter' },
  { id: 'this-quarter', label: 'This quarter' },
  { id: 'this-year', label: 'This year' },
  { id: 'last-year', label: 'Last year' },
  { id: 'custom', label: 'Custom' },
]

const utc = (y: number, m: number, d = 1) => Date.UTC(y, m, d) / 1000

export function presetPeriod(id: Exclude<PresetId, 'custom'>, now: Date = new Date()): Period {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const q = Math.floor(m / 3) * 3
  switch (id) {
    case 'this-month':
      return { start: utc(y, m), end: utc(y, m + 1) }
    case 'last-month':
      return { start: utc(y, m - 1), end: utc(y, m) }
    case 'this-quarter':
      return { start: utc(y, q), end: utc(y, q + 3) }
    case 'last-quarter':
      return { start: utc(y, q - 3), end: utc(y, q) }
    case 'this-year':
      return { start: utc(y, 0), end: utc(y + 1, 0) }
    case 'last-year':
      return { start: utc(y - 1, 0), end: utc(y, 0) }
  }
}

/** Custom range from two YYYY-MM-DD dates, both inclusive (UTC days). */
export function customPeriod(firstDay: string, lastDay: string): Period | null {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/
  const a = re.exec(firstDay)
  const b = re.exec(lastDay)
  if (!a || !b) return null
  const start = utc(+a[1]!, +a[2]! - 1, +a[3]!)
  const end = utc(+b[1]!, +b[2]! - 1, +b[3]! + 1)
  return end > start ? { start, end } : null
}

export const isoDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10)

/** "2026-09-01 – 2026-09-30 (UTC)" — the end shown is the last included day. */
export function describePeriod(p: Period): string {
  const first = isoDay(p.start)
  const last = isoDay(p.end - 1)
  return first === last ? `${first} (UTC)` : `${first} – ${last} (UTC)`
}

/** Rough duration estimate on the public RPC (docs/ARC_FACTS.md §2 and §8). */
export function estimateScan(p: Period, nowSec = Math.floor(Date.now() / 1000)): { calls: number; minutes: number } {
  const seconds = Math.max(0, Math.min(p.end, nowSec) - p.start)
  const blocks = seconds / 0.507
  const calls = Math.ceil(blocks / 10_000) * 2
  return { calls, minutes: Math.max(1, Math.round(calls / 1.6 / 60)) }
}
