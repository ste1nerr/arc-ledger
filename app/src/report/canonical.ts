/**
 * Deterministic JSON + report hash (REPORT_SPEC §3.2): a strict subset of RFC 8785 (JCS).
 * Keys sorted by UTF-16 code units, no whitespace, JSON.stringify string escaping,
 * safe integers only (all money is strings), null allowed, undefined rejected.
 */
import { keccak256, stringToBytes, type Hex } from 'viem'
import type { CanonicalReport } from './types'

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonical JSON allows only safe integers, got ${value}`)
      return Object.is(value, -0) ? '0' : String(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj).sort()
      const parts: string[] = []
      for (const k of keys) {
        if (obj[k] === undefined) throw new TypeError(`canonical JSON forbids undefined (key "${k}")`)
        parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      }
      return `{${parts.join(',')}}`
    }
    default:
      throw new TypeError(`canonical JSON cannot encode ${typeof value}`)
  }
}

export function hashCanonical(json: string): Hex {
  return keccak256(stringToBytes(json))
}

export function reportHash(report: CanonicalReport): Hex {
  return hashCanonical(canonicalJson(report))
}
