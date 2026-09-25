/** RFC 4180 CSV helpers with a CSV-injection guard (REPORT_SPEC §5). */

export const CRLF = '\r\n'

/** Quote when needed. `text` fields get a leading ' if they start with = + - @ TAB CR. */
export function csvField(value: string, text: boolean): string {
  let v = value
  if (text && /^[=+\-@\t\r]/.test(v)) v = `'${v}`
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export interface Column<R> {
  header: string
  text: boolean
  get: (row: R) => string
}

export function toCsv<R>(columns: Column<R>[], rows: R[]): string {
  const lines = [columns.map((c) => csvField(c.header, false)).join(',')]
  for (const r of rows) lines.push(columns.map((c) => csvField(c.get(r), c.text)).join(','))
  return lines.join(CRLF) + CRLF
}

/** Fold to printable ASCII (for Xero/QBO): strip accents, drop everything else. */
export function asciiFold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
