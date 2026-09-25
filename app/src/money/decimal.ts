/**
 * Exact money math on bigint raw units. See docs/REPORT_SPEC.md §1.
 * Nothing in this module (or any money path) may use JS `number` for amounts.
 */

const pow10Cache = new Map<number, bigint>()

export function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new RangeError(`bad decimals: ${decimals}`)
  let v = pow10Cache.get(decimals)
  if (v === undefined) {
    v = 10n ** BigInt(decimals)
    pow10Cache.set(decimals, v)
  }
  return v
}

/** Canonical decimal string: no trailing fractional zeros, no '.', '0' for zero, never '-0'. */
export function formatUnitsExact(raw: bigint, decimals: number): string {
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const base = pow10(decimals)
  const int = abs / base
  const frac = decimals === 0 ? '' : (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  const body = frac ? `${int}.${frac}` : int.toString()
  return negative && abs !== 0n ? `-${body}` : body
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/

/** Parse a plain decimal string into raw units. Throws on more fractional digits than `decimals`. */
export function parseUnitsExact(value: string, decimals: number): bigint {
  const m = DECIMAL_RE.exec(value)
  if (!m) throw new SyntaxError(`not a decimal string: ${JSON.stringify(value)}`)
  const [, sign, int, frac = ''] = m
  if (frac.length > decimals) throw new RangeError(`${value} has more than ${decimals} decimals`)
  const raw = BigInt(int!) * pow10(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
  return sign ? -raw : raw
}

/** Canonical form check (what REPORT_SPEC calls a canonical decimal). */
export function isCanonicalDecimal(value: string): boolean {
  return /^(0|-?[1-9]\d*|-?(0|[1-9]\d*)\.\d*[1-9])$/.test(value)
}

/** Round raw units to cents (2 decimals), half away from zero. Returns an integer number of cents. */
export function roundToCents(raw: bigint, decimals: number): bigint {
  if (decimals <= 2) return raw * pow10(2 - decimals)
  const q = pow10(decimals - 2)
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  let cents = abs / q
  if ((abs % q) * 2n >= q) cents += 1n
  return negative ? -cents : cents
}

/** Format an integer number of cents as "-12.34" / "0.00". */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const body = `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
  return negative ? `-${body}` : body
}

export function sum(values: Iterable<bigint>): bigint {
  let total = 0n
  for (const v of values) total += v
  return total
}
