import { EXPLORER_URL } from '../config/arc'

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
export const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`
export const txUrl = (h: string) => `${EXPLORER_URL}/tx/${h}`
export const addrUrl = (a: string) => `${EXPLORER_URL}/address/${a}`

/** "2026-09-03 09:15:02" from an ISO UTC timestamp. */
export const utcDateTime = (iso: string) => iso.replace('T', ' ').replace('Z', '')

export const unixToUtc = (s: number) => utcDateTime(new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))

/**
 * Display a canonical decimal with thin grouping and at most `maxFrac` fractional digits,
 * marking truncation with "…" (the full value is always available in a tooltip/export).
 */
export function displayAmount(value: string, maxFrac = 6): string {
  const neg = value.startsWith('-')
  const [int, frac = ''] = (neg ? value.slice(1) : value).split('.')
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const shown = frac.length > maxFrac ? `${frac.slice(0, maxFrac)}…` : frac
  return `${neg ? '-' : ''}${grouped}${shown ? `.${shown}` : ''}`
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

export function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
