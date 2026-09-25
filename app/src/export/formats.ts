/**
 * Export formats (REPORT_SPEC §5–§6): generic CSV, Xero bank statement, QuickBooks Online (4-column), JSON.
 */
import { getAddress } from 'viem'
import { ASSET_DECIMALS, type Asset } from '../config/arc'
import { formatCents, formatUnitsExact, parseUnitsExact, roundToCents } from '../money/decimal'
import { isoSeconds } from '../report/build'
import { makeReportFile } from '../report/file'
import { rowKey, type Annotations, type CanonicalReport, type CanonicalRow } from '../report/types'
import { asciiFold, toCsv, type Column } from './csv'

export type ExportFormat = 'generic' | 'xero' | 'qbo' | 'json'

export interface ExportFile {
  name: string
  mime: string
  content: string
}

const BOM = '\ufeff'
const CSV_MIME = 'text/csv;charset=utf-8'

export function baseName(report: CanonicalReport): string {
  const first = isoSeconds(report.periodStart).slice(0, 10)
  const last = isoSeconds(report.periodEnd - 1).slice(0, 10)
  return `arc-ledger_${report.address.slice(2, 10)}_${first}_${last}`
}

const label = (a: Annotations, addr: string) => a.counterpartyLabels[addr.toLowerCase()] ?? ''
const category = (a: Annotations, r: CanonicalRow) => a.categories[rowKey(r)] ?? 'uncategorized'
const checksum = (addr: string) => getAddress(addr)
const lastDay = (report: CanonicalReport) => isoSeconds(report.periodEnd - 1).slice(0, 10)

// ---------------------------------------------------------------- generic CSV

interface GenericLine {
  rowType: 'transfer' | 'fee' | 'unexplained'
  timestamp: string
  blockNumber: string
  txHash: string
  logIndex: string
  direction: string
  asset: Asset
  amountRaw: bigint // signed
  counterparty: string
  counterpartyLabel: string
  memo: string
  category: string
}

export function genericLines(report: CanonicalReport, ann: Annotations): GenericLine[] {
  const out: GenericLine[] = []
  for (const r of report.rows) {
    const raw = BigInt(r.amountRaw)
    out.push({
      rowType: 'transfer',
      timestamp: r.timestamp,
      blockNumber: r.blockNumber,
      txHash: r.txHash,
      logIndex: String(r.logIndex),
      direction: r.direction,
      asset: r.asset,
      amountRaw: r.direction === 'out' ? -raw : r.direction === 'in' ? raw : 0n,
      counterparty: checksum(r.counterparty),
      counterpartyLabel: label(ann, r.counterparty),
      memo: r.memo ?? '',
      category: category(ann, r),
    })
    if (r.feeUSDC !== null) {
      out.push({
        rowType: 'fee',
        timestamp: r.timestamp,
        blockNumber: r.blockNumber,
        txHash: r.txHash,
        logIndex: '',
        direction: 'out',
        asset: 'USDC',
        amountRaw: -parseUnitsExact(r.feeUSDC, 18),
        counterparty: '',
        counterpartyLabel: '',
        memo: '',
        category: 'fee',
      })
    }
  }
  for (const a of report.assets) {
    const rec = report.reconciliation[a]
    if (!rec || rec.unexplained === '0') continue
    const raw = parseUnitsExact(rec.unexplained, ASSET_DECIMALS[a])
    out.push({
      rowType: 'unexplained',
      timestamp: isoSeconds(report.periodEnd - 1),
      blockNumber: report.blockRange.to,
      txHash: '',
      logIndex: '',
      direction: raw < 0n ? 'out' : 'in',
      asset: a,
      amountRaw: raw,
      counterparty: '',
      counterpartyLabel: '',
      memo: 'Balance change not explained by itemized transfers and fees (e.g. fee-only transactions)',
      category: 'uncategorized',
    })
  }
  return out
}

// A self transfer has amount = its value but signed_amount = 0 (it does not change the balance).
function unsignedAmount(l: GenericLine, report: CanonicalReport): string {
  if (l.rowType === 'transfer' && l.direction === 'self') {
    const r = report.rows.find((x) => x.txHash === l.txHash && String(x.logIndex) === l.logIndex)
    return r ? r.amount : '0'
  }
  const abs = l.amountRaw < 0n ? -l.amountRaw : l.amountRaw
  return formatUnitsExact(abs, ASSET_DECIMALS[l.asset])
}

export function exportGeneric(report: CanonicalReport, ann: Annotations): ExportFile {
  const cols: Column<GenericLine>[] = [
    { header: 'row_type', text: false, get: (l) => l.rowType },
    { header: 'chain_id', text: false, get: () => String(report.chainId) },
    { header: 'timestamp_utc', text: false, get: (l) => l.timestamp },
    { header: 'block_number', text: false, get: (l) => l.blockNumber },
    { header: 'tx_hash', text: false, get: (l) => l.txHash },
    { header: 'log_index', text: false, get: (l) => l.logIndex },
    { header: 'direction', text: false, get: (l) => l.direction },
    { header: 'asset', text: false, get: (l) => l.asset },
    { header: 'amount', text: false, get: (l) => unsignedAmount(l, report) },
    { header: 'signed_amount', text: false, get: (l) => formatUnitsExact(l.amountRaw, ASSET_DECIMALS[l.asset]) },
    { header: 'decimals', text: false, get: (l) => String(ASSET_DECIMALS[l.asset]) },
    { header: 'amount_raw', text: false, get: (l) => (l.amountRaw < 0n ? -l.amountRaw : l.amountRaw).toString() },
    { header: 'counterparty', text: false, get: (l) => l.counterparty },
    { header: 'counterparty_label', text: true, get: (l) => l.counterpartyLabel },
    { header: 'memo', text: true, get: (l) => l.memo },
    { header: 'category', text: true, get: (l) => l.category },
  ]
  return { name: `${baseName(report)}_generic.csv`, mime: CSV_MIME, content: BOM + toCsv(cols, genericLines(report, ann)) }
}

// ---------------------------------------------------------------- bank lines (Xero + QBO)

export interface BankLine {
  date: string // YYYY-MM-DD (UTC)
  cents: bigint // signed
  kind: 'transfer' | 'fees' | 'unexplained' | 'rounding'
  payee: string
  counterparty: string // checksummed, '' for synthetic lines
  direction: 'in' | 'out'
  memo: string
  description: string
  reference: string
}

/** REPORT_SPEC §6.2–§6.3: one statement per asset, cents, daily fee lines, unexplained + rounding lines. */
export function bankLines(report: CanonicalReport, ann: Annotations, asset: Asset): BankLine[] {
  const d = ASSET_DECIMALS[asset]
  const lines: BankLine[] = []
  let exactTarget = 0n // raw units: net (+ unexplained) → the statement's exact balance change

  for (const r of report.rows) {
    if (r.asset !== asset || r.direction === 'self') continue
    const raw = BigInt(r.amountRaw) * (r.direction === 'out' ? -1n : 1n)
    exactTarget += raw
    const cp = checksum(r.counterparty)
    const memo = r.memo ? asciiFold(r.memo) : ''
    lines.push({
      date: r.timestamp.slice(0, 10),
      cents: roundToCents(raw, d),
      kind: 'transfer',
      payee: asciiFold(label(ann, r.counterparty)) || cp,
      counterparty: cp,
      direction: r.direction,
      memo,
      description: `Arc ${asset} ${r.direction === 'in' ? 'received from' : 'sent to'} ${cp}${memo ? ` - memo: ${memo}` : ''} - tx ${r.txHash}`,
      reference: `${r.txHash.slice(0, 10)}:${r.logIndex}`,
    })
  }

  if (asset === 'USDC') {
    const byDay = new Map<string, { raw: bigint; n: number }>()
    for (const r of report.rows) {
      if (r.feeUSDC === null) continue
      const day = r.timestamp.slice(0, 10)
      const e = byDay.get(day) ?? { raw: 0n, n: 0 }
      e.raw += parseUnitsExact(r.feeUSDC, 18)
      e.n += 1
      byDay.set(day, e)
    }
    for (const [day, e] of byDay) {
      exactTarget -= e.raw
      const cents = roundToCents(-e.raw, 18)
      if (cents === 0n) continue
      lines.push({
        date: day,
        cents,
        kind: 'fees',
        payee: 'Arc network',
        counterparty: '',
        direction: 'out',
        memo: '',
        description: `Arc network fees (${e.n} tx) exact ${formatUnitsExact(e.raw, 18)} USDC`,
        reference: `fees:${day}`,
      })
    }
  }

  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) // stable: keeps row order within a day

  const rec = report.reconciliation[asset]
  if (rec && rec.unexplained !== '0') {
    const raw = parseUnitsExact(rec.unexplained, d)
    exactTarget += raw
    const cents = roundToCents(raw, d)
    if (cents !== 0n) {
      lines.push({
        date: lastDay(report),
        cents,
        kind: 'unexplained',
        payee: 'Arc Ledger',
        counterparty: '',
        direction: cents < 0n ? 'out' : 'in',
        memo: '',
        description: `Unexplained on-chain balance change ${rec.unexplained} ${asset} (e.g. fee-only transactions) - see Arc Ledger report`,
        reference: 'unexplained',
      })
    }
  }

  const adjustment = roundToCents(exactTarget, d) - lines.reduce((s, l) => s + l.cents, 0n)
  if (adjustment !== 0n) {
    lines.push({
      date: lastDay(report),
      cents: adjustment,
      kind: 'rounding',
      payee: 'Arc Ledger',
      counterparty: '',
      direction: adjustment < 0n ? 'out' : 'in',
      memo: '',
      description: `Rounding adjustment: 2-decimal lines vs exact on-chain total ${formatUnitsExact(exactTarget, d)} ${asset}`,
      reference: 'rounding',
    })
  }
  return lines
}

const bankAssets = (report: CanonicalReport): Asset[] => report.assets

export function exportXero(report: CanonicalReport, ann: Annotations): ExportFile[] {
  const cols: Column<BankLine>[] = [
    { header: 'Date', text: false, get: (l) => l.date.replace(/-/g, '/') },
    { header: 'Amount', text: false, get: (l) => formatCents(l.cents) },
    { header: 'Payee', text: true, get: (l) => asciiFold(l.payee) },
    { header: 'Description', text: true, get: (l) => asciiFold(l.description) },
    { header: 'Reference', text: true, get: (l) => l.reference },
  ]
  return bankAssets(report).map((asset) => ({
    name: `${baseName(report)}_xero_${asset}.csv`,
    mime: CSV_MIME,
    content: toCsv(cols, bankLines(report, ann, asset)),
  }))
}

export const QBO_MAX_LINES = 1000
export const QBO_MAX_BYTES = 350 * 1024

export function qboDescription(l: BankLine): string {
  let text: string
  if (l.kind === 'transfer') text = `${l.direction === 'in' ? 'Received from' : 'Paid to'} ${l.payee}${l.memo ? ` - ${l.memo}` : ''}`
  else if (l.kind === 'fees') text = 'Arc network fees'
  else if (l.kind === 'rounding') text = 'Arc Ledger rounding adjustment'
  else text = 'Arc Ledger unexplained balance change'
  return asciiFold(text)
    .replace(/[^A-Za-z0-9 .,-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function exportQbo(report: CanonicalReport, ann: Annotations): ExportFile[] {
  const cols: Column<BankLine>[] = [
    {
      header: 'Date',
      text: false,
      get: (l) => {
        const [y, m, d] = l.date.split('-')
        return `${d}/${m}/${y}`
      },
    },
    { header: 'Description', text: true, get: qboDescription },
    { header: 'Credit', text: false, get: (l) => (l.cents > 0n ? formatCents(l.cents) : '') },
    { header: 'Debit', text: false, get: (l) => (l.cents < 0n ? formatCents(-l.cents) : '') },
  ]
  const files: ExportFile[] = []
  for (const asset of bankAssets(report)) {
    const lines = bankLines(report, ann, asset)
    const headerBytes = byteLength(toCsv(cols, []))
    const parts: BankLine[][] = []
    let current: BankLine[] = []
    let bytes = headerBytes
    for (const l of lines) {
      const lineBytes = byteLength(toCsv(cols, [l])) - headerBytes
      if (current.length > 0 && (current.length >= QBO_MAX_LINES || bytes + lineBytes > QBO_MAX_BYTES)) {
        parts.push(current)
        current = []
        bytes = headerBytes
      }
      current.push(l)
      bytes += lineBytes
    }
    parts.push(current)
    parts.forEach((p, i) =>
      files.push({
        name: `${baseName(report)}_qbo_${asset}${parts.length > 1 ? `_part${i + 1}` : ''}.csv`,
        mime: CSV_MIME,
        content: toCsv(cols, p),
      }),
    )
  }
  return files
}

const byteLength = (s: string) => new TextEncoder().encode(s).length

export function exportJson(report: CanonicalReport, ann: Annotations, now?: Date): ExportFile {
  return {
    name: `${baseName(report)}.report.json`,
    mime: 'application/json',
    content: JSON.stringify(makeReportFile(report, ann, now), null, 2) + '\n',
  }
}

export function exportFiles(format: ExportFormat, report: CanonicalReport, ann: Annotations): ExportFile[] {
  switch (format) {
    case 'generic':
      return [exportGeneric(report, ann)]
    case 'xero':
      return exportXero(report, ann)
    case 'qbo':
      return exportQbo(report, ann)
    case 'json':
      return [exportJson(report, ann)]
  }
}
