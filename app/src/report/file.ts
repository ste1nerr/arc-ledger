/**
 * Report export file (REPORT_SPEC §3.3): create, parse and sanity-check.
 * Verify never trusts `reportHash` from the file: it re-canonicalizes `report` and hashes it.
 */
import type { Hex } from 'viem'
import { ASSETS, ASSET_DECIMALS, type Asset } from '../config/arc'
import { formatUnitsExact, isCanonicalDecimal } from '../money/decimal'
import { computeRawTotals } from './build'
import { reportHash } from './canonical'
import { CATEGORIES, type Annotations, type CanonicalReport, type Category, type ReportFile } from './types'

export const APP_VERSION = '0.1.0'

export function makeReportFile(report: CanonicalReport, annotations: Annotations, now = new Date()): ReportFile {
  return {
    format: 'arc-ledger-report',
    reportHash: reportHash(report),
    report,
    annotations,
    generator: { name: 'arc-ledger', version: APP_VERSION, generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z') },
  }
}

export class ReportFileError extends Error {}

const HEX32 = /^0x[0-9a-f]{64}$/
const ADDR = /^0x[0-9a-f]{40}$/
const UINT = /^(0|[1-9]\d*)$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const UNSIGNED = /^(0|[1-9]\d*|(0|[1-9]\d*)\.\d*[1-9])$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function exactKeys(o: Obj, keys: string[], where: string, optional: string[] = []) {
  for (const k of keys) if (!(k in o)) throw new ReportFileError(`${where}: missing "${k}"`)
  for (const k of Object.keys(o)) if (!keys.includes(k) && !optional.includes(k)) throw new ReportFileError(`${where}: unexpected field "${k}"`)
}

function str(v: unknown, re: RegExp, where: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw new ReportFileError(`${where}: invalid value ${JSON.stringify(v)}`)
  return v
}

function int(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ReportFileError(`${where}: expected a non-negative integer`)
  return v
}

/** Parse and structurally validate a report file. Does not check the hash. */
export function parseReportFile(text: string): ReportFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new ReportFileError('Not valid JSON.')
  }
  if (!isObj(data) || data.format !== 'arc-ledger-report') throw new ReportFileError('This is not an Arc Ledger report file (missing "format": "arc-ledger-report").')
  exactKeys(data, ['format', 'reportHash', 'report'], 'file', ['annotations', 'generator'])
  str(data.reportHash, HEX32, 'reportHash')
  const report = validateReport(data.report)
  const annotations = data.annotations === undefined ? undefined : validateAnnotations(data.annotations)
  return {
    format: 'arc-ledger-report',
    reportHash: data.reportHash as Hex,
    report,
    ...(annotations ? { annotations } : {}),
    ...(isObj(data.generator) ? { generator: data.generator as ReportFile['generator'] & object } : {}),
  }
}

function validateReport(r: unknown): CanonicalReport {
  if (!isObj(r)) throw new ReportFileError('report: expected an object')
  exactKeys(r, ['version', 'chainId', 'address', 'periodStart', 'periodEnd', 'blockRange', 'assets', 'rows', 'totals', 'reconciliation'], 'report')
  if (r.version !== 1) throw new ReportFileError(`report.version: unsupported version ${JSON.stringify(r.version)}`)
  int(r.chainId, 'report.chainId')
  str(r.address, ADDR, 'report.address')
  const start = int(r.periodStart, 'report.periodStart')
  const end = int(r.periodEnd, 'report.periodEnd')
  if (end <= start) throw new ReportFileError('report.periodEnd must be after periodStart')
  if (!isObj(r.blockRange)) throw new ReportFileError('report.blockRange: expected an object')
  exactKeys(r.blockRange, ['from', 'to'], 'report.blockRange')
  str(r.blockRange.from, UINT, 'report.blockRange.from')
  str(r.blockRange.to, UINT, 'report.blockRange.to')
  if (!Array.isArray(r.assets) || r.assets.length === 0) throw new ReportFileError('report.assets: expected a non-empty array')
  for (const a of r.assets) if (!ASSETS.includes(a as Asset)) throw new ReportFileError(`report.assets: unknown asset ${JSON.stringify(a)}`)
  if (!Array.isArray(r.rows)) throw new ReportFileError('report.rows: expected an array')
  r.rows.forEach((row, i) => validateRow(row, `report.rows[${i}]`))
  if (!isObj(r.totals) || !isObj(r.reconciliation)) throw new ReportFileError('report.totals / report.reconciliation: expected objects')
  return r as unknown as CanonicalReport
}

function validateRow(row: unknown, where: string) {
  if (!isObj(row)) throw new ReportFileError(`${where}: expected an object`)
  exactKeys(row, ['txHash', 'logIndex', 'blockNumber', 'timestamp', 'direction', 'asset', 'amount', 'amountRaw', 'decimals', 'counterparty', 'memo', 'feeUSDC'], where)
  str(row.txHash, HEX32, `${where}.txHash`)
  int(row.logIndex, `${where}.logIndex`)
  str(row.blockNumber, UINT, `${where}.blockNumber`)
  str(row.timestamp, ISO, `${where}.timestamp`)
  if (!['in', 'out', 'self'].includes(row.direction as string)) throw new ReportFileError(`${where}.direction: invalid`)
  if (!ASSETS.includes(row.asset as Asset)) throw new ReportFileError(`${where}.asset: invalid`)
  str(row.amount, UNSIGNED, `${where}.amount`)
  str(row.amountRaw, UINT, `${where}.amountRaw`)
  if (row.decimals !== 6 && row.decimals !== 18) throw new ReportFileError(`${where}.decimals: invalid`)
  str(row.counterparty, ADDR, `${where}.counterparty`)
  if (row.memo !== null && typeof row.memo !== 'string') throw new ReportFileError(`${where}.memo: invalid`)
  if (row.feeUSDC !== null) str(row.feeUSDC, UNSIGNED, `${where}.feeUSDC`)
}

function validateAnnotations(a: unknown): Annotations {
  if (!isObj(a)) throw new ReportFileError('annotations: expected an object')
  const labels: Record<string, string> = {}
  const categories: Record<string, Category> = {}
  if (isObj(a.counterpartyLabels)) for (const [k, v] of Object.entries(a.counterpartyLabels)) if (ADDR.test(k) && typeof v === 'string') labels[k] = v.slice(0, 200)
  if (isObj(a.categories)) for (const [k, v] of Object.entries(a.categories)) if (/^0x[0-9a-f]{64}:\d+$/.test(k) && CATEGORIES.includes(v as Category)) categories[k] = v as Category
  return { counterpartyLabels: labels, categories }
}

/**
 * Internal consistency of a (possibly hand-edited) report: amounts match raw values,
 * totals match rows, rows are sorted. A matching hash already proves integrity; this
 * explains *what* is off when a file does not match.
 */
export function checkReportConsistency(report: CanonicalReport): string[] {
  const problems: string[] = []
  report.rows.forEach((row, i) => {
    if (row.decimals !== ASSET_DECIMALS[row.asset]) problems.push(`Row ${i + 1}: wrong decimals for ${row.asset}.`)
    else if (formatUnitsExact(BigInt(row.amountRaw), row.decimals) !== row.amount) problems.push(`Row ${i + 1}: amount ${row.amount} does not match amountRaw ${row.amountRaw}.`)
    const prev = report.rows[i - 1]
    if (prev && (BigInt(prev.blockNumber) > BigInt(row.blockNumber) || (prev.blockNumber === row.blockNumber && prev.logIndex >= row.logIndex))) problems.push(`Row ${i + 1}: rows are not sorted by (block, logIndex).`)
  })
  const raw = computeRawTotals(report.rows, report.assets)
  for (const a of report.assets) {
    const t = report.totals[a]
    const r = raw[a]!
    const d = ASSET_DECIMALS[a]
    if (!t) {
      problems.push(`Totals for ${a} are missing.`)
      continue
    }
    for (const k of ['in', 'out', 'fees', 'net'] as const) {
      if (!isCanonicalDecimal(t[k]) || t[k] !== formatUnitsExact(r[k], d)) problems.push(`${a} total "${k}" is ${t[k]} but the rows add up to ${formatUnitsExact(r[k], d)}.`)
    }
  }
  return problems
}
