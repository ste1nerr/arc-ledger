import type { Address, Hex } from 'viem'
import type { Asset } from '../config/arc'

export type Direction = 'in' | 'out' | 'self'
export const CATEGORIES = ['income', 'expense', 'transfer', 'fee', 'uncategorized'] as const
export type Category = (typeof CATEGORIES)[number]

/** Canonical row (REPORT_SPEC §3.1): exactly the hashed fields. */
export interface CanonicalRow {
  txHash: Hex
  logIndex: number
  blockNumber: string
  timestamp: string
  direction: Direction
  asset: Asset
  amount: string
  amountRaw: string
  decimals: number
  counterparty: Address // lowercase
  memo: string | null
  feeUSDC: string | null
}

/** Internal ledger row (REPORT_SPEC §2). Labels/categories are joined in from local annotations. */
export interface LedgerRow extends CanonicalRow {
  chainId: number
  counterpartyLabel: string
  category: Category
}

export interface AssetTotals {
  in: string
  out: string
  fees: string
  net: string
}

export interface AssetReconciliation {
  opening: string
  closing: string
  unexplained: string
}

export interface Reconciliation {
  sentTxCount: number
  itemizedSentTxCount: number
  USDC?: AssetReconciliation
  EURC?: AssetReconciliation
}

export interface CanonicalReport {
  version: 1
  chainId: number
  address: Address // lowercase
  periodStart: number
  periodEnd: number
  blockRange: { from: string; to: string }
  assets: Asset[]
  rows: CanonicalRow[]
  totals: Partial<Record<Asset, AssetTotals>>
  reconciliation: Reconciliation
}

export interface Annotations {
  counterpartyLabels: Record<string, string> // lowercase address → label
  categories: Record<string, Category> // `${txHash}:${logIndex}` → category
}

export interface ReportFile {
  format: 'arc-ledger-report'
  reportHash: Hex
  report: CanonicalReport
  annotations?: Annotations
  generator?: { name: string; version: string; generatedAt: string }
}

export const rowKey = (r: { txHash: string; logIndex: number }) => `${r.txHash}:${r.logIndex}`
