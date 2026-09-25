/** PeriodCloseRegistry: ABI and read helpers (no wallet needed). */
import { createPublicClient, custom, parseAbi, parseAbiItem, type Address, type Hex } from 'viem'
import { arcMainnet } from '../config/arc'
import type { Rpc } from './rpc'

export const registryAbi = parseAbi([
  'struct Close { bytes32 reportHash; uint64 periodStart; uint64 periodEnd; uint32 rowCount; uint64 closedAt; uint64 blockNumber; string uri; }',
  'event PeriodClosed(address indexed account, bytes32 indexed reportHash, uint64 periodStart, uint64 periodEnd, uint32 rowCount, string uri)',
  'error InvalidPeriod(uint64 periodStart, uint64 periodEnd)',
  'error ZeroReportHash()',
  'error AlreadyClosed(bytes32 reportHash, uint256 index)',
  'function closePeriod(bytes32 reportHash, uint64 periodStart, uint64 periodEnd, uint32 rowCount, string uri) returns (uint256 index)',
  'function closeCount(address account) view returns (uint256)',
  'function closesOf(address account) view returns (Close[])',
  'function closesOfPaged(address account, uint256 offset, uint256 limit) view returns (Close[] page)',
  'function findClose(address account, bytes32 reportHash) view returns (bool found, uint256 index, Close close)',
])

export const periodClosedEvent = parseAbiItem(
  'event PeriodClosed(address indexed account, bytes32 indexed reportHash, uint64 periodStart, uint64 periodEnd, uint32 rowCount, string uri)',
)

export interface CloseRecord {
  index: number
  reportHash: Hex
  periodStart: number
  periodEnd: number
  rowCount: number
  closedAt: number
  blockNumber: bigint
  uri: string
}

export function registryClient(rpc: Rpc) {
  return createPublicClient({
    chain: arcMainnet,
    transport: custom({ request: ({ method, params }) => rpc.call(method, (params as unknown[] | undefined) ?? []) }),
  })
}

export async function readCloses(rpc: Rpc, registry: Address, account: Address): Promise<CloseRecord[]> {
  const closes = await registryClient(rpc).readContract({ address: registry, abi: registryAbi, functionName: 'closesOf', args: [account] })
  return closes.map((c, index) => ({
    index,
    reportHash: c.reportHash,
    periodStart: parseInt(c.periodStart.toString(), 10),
    periodEnd: parseInt(c.periodEnd.toString(), 10),
    rowCount: c.rowCount,
    closedAt: parseInt(c.closedAt.toString(), 10),
    blockNumber: c.blockNumber,
    uri: c.uri,
  }))
}

/** Find the tx that emitted a given close (one-block log query, cheap). */
export async function findCloseTx(rpc: Rpc, registry: Address, account: Address, close: CloseRecord): Promise<Hex | null> {
  const logs = await registryClient(rpc).getLogs({
    address: registry,
    event: periodClosedEvent,
    args: { account, reportHash: close.reportHash },
    fromBlock: close.blockNumber,
    toBlock: close.blockNumber,
  })
  return logs[0]?.transactionHash ?? null
}

export type VerifyOutcome =
  | { kind: 'match'; close: CloseRecord; total: number }
  | { kind: 'amended'; close: CloseRecord; newer: CloseRecord; total: number }
  | { kind: 'no-match'; samePeriod: CloseRecord[]; total: number }

/**
 * Compare a recomputed hash with the account's close history.
 * The newest close for the same period wins (amendments append).
 */
export function verifyAgainst(closes: CloseRecord[], hash: Hex, periodStart: number, periodEnd: number): VerifyOutcome {
  const h = hash.toLowerCase()
  const samePeriod = closes.filter((c) => c.periodStart === periodStart && c.periodEnd === periodEnd)
  const match = closes.find((c) => c.reportHash.toLowerCase() === h)
  if (!match) return { kind: 'no-match', samePeriod, total: closes.length }
  const newer = samePeriod.filter((c) => c.index > match.index).at(-1)
  return newer ? { kind: 'amended', close: match, newer, total: closes.length } : { kind: 'match', close: match, total: closes.length }
}
