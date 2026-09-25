/**
 * fetchLedger: collect every USDC/EURC movement of an address in a period straight from
 * public Arc RPC (data-source decision C, docs/ARC_FACTS.md §8), then build the report.
 */
import { getAddress, type Address, type Hex } from 'viem'
import { ARC_CHAIN_ID, ASSETS, ASSET_EMITTER, EURC, MEMO_CONTRACT, MEMO_TOPIC, TRANSFER_TOPIC, USDC_ERC20, type Asset } from '../config/arc'
import { erc20ToNative } from '../money/usdc'
import { buildReport, type LedgerSource, type RawTransfer, type TxInfo } from '../report/build'
import type { CanonicalReport } from '../report/types'
import { BlockClock } from './blocks'
import { cachingRpc } from './cache'
import { abortError, isPruned, isRangeError, type Rpc } from './rpc'

export type Phase = 'range' | 'logs' | 'receipts' | 'blocks' | 'balances' | 'done'

export interface Progress {
  phase: Phase
  /** Units of work finished / planned in this phase. */
  done: number
  total: number
  /** Blocks scanned for logs so far / total blocks in range (logs phase). */
  blocksScanned?: bigint
  blocksTotal?: bigint
  message: string
  /** Set while the scan is paused on a transient RPC failure. */
  waiting?: string
}

export interface FetchLedgerOptions {
  rpc: Rpc
  assets?: Asset[]
  signal?: AbortSignal
  onProgress?: (p: Progress) => void
  /** Parallel log requests (the rate limiter still paces them). */
  concurrency?: number
}

export interface LedgerResult {
  report: CanonicalReport
  source: LedgerSource
  head: { number: bigint; timestamp: number }
  /** true if the period ends after the latest block (still in progress). */
  partial: boolean
  stats: { rpcCalls: number; ms: number }
}

interface RawLog {
  address: string
  /** Returned by Arc's nodes (reth); saves one eth_getBlockByNumber per block. */
  blockTimestamp?: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  logIndex: string
}

interface RawReceipt {
  from: string
  gasUsed: string
  effectiveGasPrice: string
  logs: RawLog[]
}

const hex = (n: bigint) => `0x${n.toString(16)}`
const topicAddress = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
const addrFromTopic = (t: string) => getAddress(`0x${t.slice(26)}`)

export class LedgerError extends Error {}

/** Split [from, to] into windows no larger than `size` blocks. */
export function windows(from: bigint, to: bigint, size: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = []
  for (let a = from; a <= to; a += size) out.push([a, a + size - 1n < to ? a + size - 1n : to])
  return out
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>, signal?: AbortSignal) {
  let i = 0
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      if (signal?.aborted) throw abortError()
      const item = items[i++]!
      await worker(item)
    }
  })
  await Promise.all(lanes)
}

export async function fetchLedger(address: Address, periodStart: number, periodEnd: number, opts: FetchLedgerOptions): Promise<LedgerResult> {
  const t0 = Date.now()
  const { signal } = opts
  const rpc = cachingRpc(opts.rpc) // resumable: finished windows/receipts are not fetched again on retry
  const assets = ASSETS.filter((a) => (opts.assets ?? ASSETS).includes(a))
  if (assets.length === 0) throw new LedgerError('Pick at least one asset.')
  if (!(periodEnd > periodStart)) throw new LedgerError('The period end must be after its start.')
  const me = getAddress(address)
  let calls = 0
  let lastProgress: Progress | null = null
  const report = (p: Progress) => {
    lastProgress = p
    opts.onProgress?.(p)
  }
  // Transient RPC trouble (rate limits, dropped connections) pauses the scan instead of failing it.
  let succeeded = 0
  const onRetry = ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: unknown }) => {
    if (!lastProgress || !opts.onProgress) return
    const msg = error instanceof Error ? error.message : ''
    const rateLimited = /rate limit|429/i.test(msg)
    const host = /calling ([\w.-]+)/.exec(msg)?.[1] ?? 'the Arc RPC'
    const why = rateLimited
      ? 'The public RPC is rate-limiting us'
      : succeeded === 0 && attempt >= 3
        ? `This browser cannot reach ${host}. An ad/tracker-blocking extension, VPN or firewall may be blocking it; try a private window or allow the site`
        : 'The RPC dropped a request'
    opts.onProgress({ ...lastProgress, waiting: `${why}; retrying in ${Math.ceil(delayMs / 1000)}s…` })
  }
  const call = async <T>(method: string, params: unknown[], pool?: string) => {
    if (signal?.aborted) throw abortError()
    calls++
    const result = await rpc.call<T>(method, params, { signal, onRetry, ...(pool ? { pool } : {}) })
    succeeded++
    return result
  }

  // 1. Period → blocks
  report({ phase: 'range', done: 0, total: 1, message: 'Finding the block range for the period…' })
  const chainId = parseInt(await call<string>('eth_chainId', []), 16)
  if (chainId !== ARC_CHAIN_ID) throw new LedgerError(`RPC is on chain ${chainId}, expected Arc mainnet (${ARC_CHAIN_ID}).`)
  const clock = new BlockClock(rpc, { signal })
  const head = await clock.head()
  const range = await clock.blockRange(periodStart, periodEnd, head)
  if (!range) throw new LedgerError('No Arc blocks fall inside this period.')
  const partial = periodEnd > head.timestamp

  // 2. Transfer logs. Fast pruned endpoints serve recent blocks with larger ranges.
  // USDC comes from the native system stream. Its ERC-20 twin (0x3600…) is also queried, but only
  // for self-transfers: Arc emits no native log when from == to (docs/ARC_FACTS.md §4).
  const emitters = [...assets.map((a) => ASSET_EMITTER[a]), ...(assets.includes('USDC') ? [USDC_ERC20] : [])]
  const archiveEp = rpc.endpoints().find((e) => e.recentOnly === undefined)
  if (!archiveEp) throw new LedgerError('No archive RPC endpoint configured.')
  const recentEp = rpc.endpoints().find((e) => e.recentOnly !== undefined)
  const recentFrom = recentEp ? head.number - recentEp.recentOnly! : null

  interface Task {
    from: bigint
    to: bigint
    pool: string
    size: bigint
  }
  const tasks: Task[] = []
  const splitAt = recentFrom !== null && recentFrom > range.from ? recentFrom : range.from
  if (recentEp && recentFrom !== null && range.to >= splitAt) {
    for (const [a, b] of windows(splitAt, range.to, recentEp.maxLogRange)) tasks.push({ from: a, to: b, pool: recentEp.pool, size: recentEp.maxLogRange })
  }
  const archiveTo = recentEp && recentFrom !== null && range.to >= splitAt ? splitAt - 1n : range.to
  if (archiveTo >= range.from) {
    for (const [a, b] of windows(range.from, archiveTo, archiveEp.maxLogRange)) tasks.push({ from: a, to: b, pool: archiveEp.pool, size: archiveEp.maxLogRange })
  }
  tasks.sort((x, y) => (x.from < y.from ? -1 : 1))

  const blocksTotal = range.to - range.from + 1n
  let blocksScanned = 0n
  let windowsDone = 0
  const transfers: RawTransfer[] = []
  const topicMe = topicAddress(me)

  async function getLogs(from: bigint, to: bigint, pool: string, topics: (string | null)[]): Promise<RawLog[]> {
    try {
      return await call<RawLog[]>('eth_getLogs', [{ address: emitters, topics, fromBlock: hex(from), toBlock: hex(to) }], pool)
    } catch (e) {
      if (isPruned(e) && pool !== archiveEp!.pool) {
        const out: RawLog[] = []
        for (const [a, b] of windows(from, to, archiveEp!.maxLogRange)) out.push(...(await getLogs(a, b, archiveEp!.pool, topics)))
        return out
      }
      if (isRangeError(e) && to > from) {
        const mid = from + (to - from) / 2n
        return [...(await getLogs(from, mid, pool, topics)), ...(await getLogs(mid + 1n, to, pool, topics))]
      }
      throw e
    }
  }

  const assetOf = (emitter: string): Asset | null => {
    const e = emitter.toLowerCase()
    for (const a of assets) if (ASSET_EMITTER[a].toLowerCase() === e) return a
    return null
  }

  report({ phase: 'logs', done: 0, total: tasks.length, blocksScanned, blocksTotal, message: 'Scanning transfer logs…' })
  await runPool(
    tasks,
    opts.concurrency ?? 3,
    async (t) => {
      const [outLogs, inLogs] = await Promise.all([getLogs(t.from, t.to, t.pool, [TRANSFER_TOPIC, topicMe]), getLogs(t.from, t.to, t.pool, [TRANSFER_TOPIC, null, topicMe])])
      for (const l of [...outLogs, ...inLogs]) {
        if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue
        let value = BigInt(l.data === '0x' ? 0 : l.data)
        let asset = assetOf(l.address)
        if (l.address.toLowerCase() === USDC_ERC20.toLowerCase()) {
          // Everything else in this stream duplicates a native log; keep only self-transfers.
          if (l.topics[1] !== topicMe || l.topics[2] !== topicMe) continue
          asset = 'USDC'
          value = erc20ToNative(value) // 6 → 18 decimals, exact
        }
        if (!asset) continue
        if (l.blockTimestamp) clock.remember(BigInt(l.blockNumber), parseInt(l.blockTimestamp, 16))
        transfers.push({
          asset,
          txHash: l.transactionHash.toLowerCase() as Hex,
          logIndex: parseInt(l.logIndex, 16),
          blockNumber: BigInt(l.blockNumber),
          from: addrFromTopic(l.topics[1]!),
          to: addrFromTopic(l.topics[2]!),
          value,
        })
      }
      windowsDone++
      blocksScanned += t.to - t.from + 1n
      report({ phase: 'logs', done: windowsDone, total: tasks.length, blocksScanned, blocksTotal, message: `Scanning transfer logs… ${transfers.length} found` })
    },
    signal,
  )

  // 3. Receipts: fee payer, gas, memos.
  const txHashes = [...new Set(transfers.map((t) => t.txHash))]
  const txs: Record<string, TxInfo> = {}
  let receiptsDone = 0
  report({ phase: 'receipts', done: 0, total: txHashes.length, message: 'Reading receipts (fees and memos)…' })
  await runPool(
    txHashes,
    opts.concurrency ?? 3,
    async (h) => {
      const r = await call<RawReceipt | null>('eth_getTransactionReceipt', [h])
      if (!r) throw new LedgerError(`Receipt not found for ${h}`)
      txs[h] = {
        from: getAddress(r.from),
        gasUsed: BigInt(r.gasUsed),
        effectiveGasPrice: BigInt(r.effectiveGasPrice),
        memos: r.logs
          .filter((l) => l.address.toLowerCase() === MEMO_CONTRACT.toLowerCase() && l.topics[0] === MEMO_TOPIC)
          .map((l) => ({ logIndex: parseInt(l.logIndex, 16), memo: decodeMemoData(l.data) })),
      }
      receiptsDone++
      report({ phase: 'receipts', done: receiptsDone, total: txHashes.length, message: 'Reading receipts (fees and memos)…' })
    },
    signal,
  )

  // 4. Block timestamps for rows.
  const blocks = [...new Set(transfers.map((t) => t.blockNumber))].filter((b) => !clock.has(b))
  let blocksDone = 0
  report({ phase: 'blocks', done: 0, total: blocks.length, message: 'Reading block timestamps…' })
  await runPool(
    blocks,
    opts.concurrency ?? 3,
    async (b) => {
      await clock.timestamp(b)
      blocksDone++
      report({ phase: 'blocks', done: blocksDone, total: blocks.length, message: 'Reading block timestamps…' })
    },
    signal,
  )

  // 5. Opening/closing balances and nonces for reconciliation.
  report({ phase: 'balances', done: 0, total: 1, message: 'Reading opening and closing balances…' })
  const before = hex(range.from > 0n ? range.from - 1n : 0n)
  const after = hex(range.to)
  const balanceAt = async (asset: Asset, tag: string) =>
    asset === 'USDC'
      ? BigInt(await call<string>('eth_getBalance', [me, tag]))
      : BigInt(await call<string>('eth_call', [{ to: EURC, data: `0x70a08231${topicAddress(me).slice(2)}` }, tag]))
  const opening: Partial<Record<Asset, bigint>> = {}
  const closing: Partial<Record<Asset, bigint>> = {}
  const fromGenesis = range.from === 0n // nothing exists "before" block 0
  for (const a of assets) {
    opening[a] = fromGenesis ? 0n : await balanceAt(a, before)
    closing[a] = await balanceAt(a, after)
  }
  const nonces = {
    opening: fromGenesis ? 0 : parseInt(await call<string>('eth_getTransactionCount', [me, before]), 16),
    closing: parseInt(await call<string>('eth_getTransactionCount', [me, after]), 16),
  }

  const source: LedgerSource = {
    chainId,
    address: me,
    periodStart,
    periodEnd,
    blockRange: range,
    assets,
    transfers,
    txs,
    blockTimestamps: clock.known(),
    balances: { opening, closing },
    nonces,
  }
  const built = buildReport(source)
  report({ phase: 'done', done: 1, total: 1, message: `Done: ${built.rows.length} movements` })
  return { report: built, source, head, partial, stats: { rpcCalls: calls + clock.calls, ms: Date.now() - t0 } }
}

/** ABI-decode the non-indexed Memo fields (bytes32 callDataHash, bytes memo, uint256 memoIndex) → memo bytes. */
export function decodeMemoData(data: string): Hex {
  const body = data.slice(2)
  const word = (i: number) => body.slice(i * 64, (i + 1) * 64)
  const offset = parseInt(word(1), 16) / 32 // offset of `memo` in 32-byte words
  const len = parseInt(word(offset), 16)
  const start = (offset + 1) * 64
  const bytes = body.slice(start, start + len * 2)
  if (bytes.length !== len * 2) throw new LedgerError('Malformed Memo event data')
  return `0x${bytes}` as Hex
}

// ---------------------------------------------------------------- in-memory cache

const cache = new Map<string, LedgerResult>()
export const cacheKey = (address: string, start: number, end: number, assets: Asset[]) => `${address.toLowerCase()}|${start}|${end}|${[...assets].sort().join(',')}`

export async function fetchLedgerCached(address: Address, periodStart: number, periodEnd: number, opts: FetchLedgerOptions & { force?: boolean }): Promise<LedgerResult> {
  const key = cacheKey(address, periodStart, periodEnd, opts.assets ?? [...ASSETS])
  const hit = cache.get(key)
  if (hit && !opts.force) return hit
  const result = await fetchLedger(address, periodStart, periodEnd, opts)
  if (!result.partial) cache.set(key, result) // a period still in progress changes over time
  return result
}
