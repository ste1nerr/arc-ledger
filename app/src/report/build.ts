/**
 * Pure assembly of the canonical report from raw chain data (REPORT_SPEC §2–§3).
 * No I/O here: the data layer (src/chain) collects a LedgerSource, this turns it into a report.
 */
import type { Address, Hex } from 'viem'
import { ASSETS, ASSET_DECIMALS, type Asset } from '../config/arc'
import { formatUnitsExact, parseUnitsExact } from '../money/decimal'
import type { AssetTotals, CanonicalReport, CanonicalRow, Direction, Reconciliation } from './types'

export interface RawTransfer {
  asset: Asset
  txHash: Hex
  logIndex: number
  blockNumber: bigint
  from: Address
  to: Address
  value: bigint // raw units at ASSET_DECIMALS[asset]
}

export interface TxInfo {
  /** receipt.from: the account that paid gas */
  from: Address
  gasUsed: bigint
  effectiveGasPrice: bigint
  /** Memo event payloads in this tx, in any order */
  memos: { logIndex: number; memo: Hex }[]
}

export interface LedgerSource {
  chainId: number
  address: Address
  periodStart: number
  periodEnd: number
  blockRange: { from: bigint; to: bigint }
  assets: Asset[]
  transfers: RawTransfer[]
  txs: Record<string, TxInfo> // lowercase tx hash → info
  blockTimestamps: Record<string, number> // block number (decimal string) → unix seconds
  balances: { opening: Partial<Record<Asset, bigint>>; closing: Partial<Record<Asset, bigint>> }
  nonces: { opening: number; closing: number }
}

const lower = <T extends string>(v: T) => v.toLowerCase() as T

export function isoSeconds(unixSeconds: number): string {
  if (!Number.isSafeInteger(unixSeconds)) throw new TypeError(`bad timestamp ${unixSeconds}`)
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const utf8 = new TextDecoder('utf-8', { fatal: true })
// C0 controls except \t, plus DEL
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/

/** REPORT_SPEC §2.2: UTF-8 text when valid and free of control chars, else lowercase 0x-hex. */
export function decodeMemo(memo: Hex): string {
  const hex = lower(memo)
  const body = hex.slice(2)
  if (body.length % 2 !== 0 || /[^0-9a-f]/.test(body)) throw new SyntaxError(`bad memo hex ${memo}`)
  const bytes = new Uint8Array(body.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  try {
    const text = utf8.decode(bytes)
    if (!CONTROL_RE.test(text)) return text
  } catch {
    /* not UTF-8 */
  }
  return hex
}

export function compareRows(a: { blockNumber: bigint | string; logIndex: number }, b: { blockNumber: bigint | string; logIndex: number }): number {
  const ba = BigInt(a.blockNumber)
  const bb = BigInt(b.blockNumber)
  if (ba !== bb) return ba < bb ? -1 : 1
  return a.logIndex - b.logIndex
}

export function buildReport(src: LedgerSource): CanonicalReport {
  const me = lower(src.address)
  const assets = ASSETS.filter((a) => src.assets.includes(a))
  if (assets.length === 0) throw new Error('report needs at least one asset')
  if (src.periodEnd <= src.periodStart) throw new Error('periodEnd must be after periodStart')
  if (src.blockRange.to < src.blockRange.from) throw new Error('period contains no blocks')

  // De-duplicate (the from=me and to=me queries both return self transfers) and filter.
  const seen = new Map<string, RawTransfer>()
  for (const t of src.transfers) {
    if (!assets.includes(t.asset)) continue
    if (t.blockNumber < src.blockRange.from || t.blockNumber > src.blockRange.to) continue
    const from = lower(t.from)
    const to = lower(t.to)
    if (from !== me && to !== me) continue
    seen.set(`${t.blockNumber}:${t.logIndex}`, t)
  }
  const transfers = [...seen.values()].sort(compareRows)

  // Fee goes on the first row of each tx that `me` paid for (REPORT_SPEC §2.1).
  const feeTaken = new Set<string>()
  const rows: CanonicalRow[] = transfers.map((t) => {
    const txHash = lower(t.txHash)
    const info = src.txs[txHash]
    if (!info) throw new Error(`missing receipt for ${txHash}`)
    const ts = src.blockTimestamps[t.blockNumber.toString()]
    if (ts === undefined) throw new Error(`missing timestamp for block ${t.blockNumber}`)

    const from = lower(t.from)
    const to = lower(t.to)
    const direction: Direction = from === me && to === me ? 'self' : from === me ? 'out' : 'in'
    const counterparty = direction === 'out' ? to : direction === 'in' ? from : me

    let feeUSDC: string | null = null
    if (lower(info.from) === me && !feeTaken.has(txHash)) {
      feeTaken.add(txHash)
      feeUSDC = formatUnitsExact(info.gasUsed * info.effectiveGasPrice, ASSET_DECIMALS.USDC)
    }

    const memos = [...info.memos].sort((a, b) => a.logIndex - b.logIndex).map((m) => decodeMemo(m.memo))
    const decimals = ASSET_DECIMALS[t.asset]
    return {
      txHash,
      logIndex: t.logIndex,
      blockNumber: t.blockNumber.toString(),
      timestamp: isoSeconds(ts),
      direction,
      asset: t.asset,
      amount: formatUnitsExact(t.value, decimals),
      amountRaw: t.value.toString(),
      decimals,
      counterparty,
      memo: memos.length ? memos.join(' | ') : null,
      feeUSDC,
    }
  })

  const rawTotals = computeRawTotals(rows, assets)
  const totals: Partial<Record<Asset, AssetTotals>> = {}
  for (const a of assets) totals[a] = formatTotals(rawTotals[a]!, ASSET_DECIMALS[a])

  const reconciliation: Reconciliation = {
    sentTxCount: src.nonces.closing - src.nonces.opening,
    itemizedSentTxCount: feeTaken.size,
  }
  for (const a of assets) {
    const opening = src.balances.opening[a]
    const closing = src.balances.closing[a]
    if (opening === undefined || closing === undefined) throw new Error(`missing ${a} balances`)
    const d = ASSET_DECIMALS[a]
    reconciliation[a] = {
      opening: formatUnitsExact(opening, d),
      closing: formatUnitsExact(closing, d),
      unexplained: formatUnitsExact(closing - opening - rawTotals[a]!.net, d),
    }
  }

  return {
    version: 1,
    chainId: src.chainId,
    address: me,
    periodStart: src.periodStart,
    periodEnd: src.periodEnd,
    blockRange: { from: src.blockRange.from.toString(), to: src.blockRange.to.toString() },
    assets,
    rows,
    totals,
    reconciliation,
  }
}

export interface RawTotals {
  in: bigint
  out: bigint
  fees: bigint
  net: bigint
}

/** Totals in raw units per asset. Fees always count toward USDC (REPORT_SPEC §3.1). */
export function computeRawTotals(rows: CanonicalRow[], assets: readonly Asset[]): Partial<Record<Asset, RawTotals>> {
  const out: Partial<Record<Asset, RawTotals>> = {}
  for (const a of assets) out[a] = { in: 0n, out: 0n, fees: 0n, net: 0n }
  for (const r of rows) {
    const t = out[r.asset]
    if (t) {
      if (r.direction === 'in') t.in += BigInt(r.amountRaw)
      else if (r.direction === 'out') t.out += BigInt(r.amountRaw)
    }
    if (r.feeUSDC !== null && out.USDC) {
      out.USDC.fees += parseUnitsExact(r.feeUSDC, ASSET_DECIMALS.USDC)
    }
  }
  for (const t of Object.values(out)) t.net = t.in - t.out - t.fees
  return out
}

function formatTotals(t: RawTotals, decimals: number): AssetTotals {
  return {
    in: formatUnitsExact(t.in, decimals),
    out: formatUnitsExact(t.out, decimals),
    fees: formatUnitsExact(t.fees, decimals),
    net: formatUnitsExact(t.net, decimals),
  }
}
