/**
 * Map a UTC period [start, end) to a block range (REPORT_SPEC §4).
 * Timestamps are non-decreasing, so "first block with ts >= t" is well defined.
 */
import { BLOCK_TIME_MS_HINT } from '../config/arc'
import { abortError, type CallOptions, type Rpc } from './rpc'

export interface BlockHeader {
  number: bigint
  timestamp: number
}

export class BlockClock {
  private readonly ts = new Map<bigint, number>()
  calls = 0
  constructor(
    private readonly rpc: Rpc,
    private readonly opts: CallOptions = {},
  ) {}

  async head(): Promise<BlockHeader> {
    const n = BigInt(await this.rpc.call<string>('eth_blockNumber', [], this.opts))
    return { number: n, timestamp: await this.timestamp(n) }
  }

  async timestamp(n: bigint): Promise<number> {
    const cached = this.ts.get(n)
    if (cached !== undefined) return cached
    if (this.opts.signal?.aborted) throw abortError()
    this.calls++
    const block = await this.rpc.call<{ timestamp: string } | null>('eth_getBlockByNumber', [`0x${n.toString(16)}`, false], this.opts)
    if (!block) throw new Error(`block ${n} not found`)
    const t = parseInt(block.timestamp, 16)
    this.ts.set(n, t)
    return t
  }

  /** Timestamps already known from elsewhere (e.g. `blockTimestamp` on logs) cost no call. */
  remember(n: bigint, timestamp: number) {
    this.ts.set(n, timestamp)
  }

  has(n: bigint): boolean {
    return this.ts.has(n)
  }

  known(): Record<string, number> {
    return Object.fromEntries([...this.ts].map(([n, t]) => [n.toString(), t]))
  }

  /**
   * Lowest block with timestamp >= t, searching in [0, head]. Returns head+1 if none.
   * Interpolation search with a bisection fallback, typically ~6–12 calls.
   */
  async firstBlockAtOrAfter(t: number, head: BlockHeader): Promise<bigint> {
    if (head.timestamp < t) return head.number + 1n
    // 1. Guess from the average block time, then gallop outwards to bracket t: ts(lo) < t <= ts(hi).
    const back = BigInt(Math.max(0, Math.floor(((head.timestamp - t) * 1000) / BLOCK_TIME_MS_HINT)))
    let guess = head.number > back ? head.number - back : 0n
    let lo: bigint
    let hi: bigint
    let step = 2_000n
    if ((await this.timestamp(guess)) >= t) {
      hi = guess
      for (;;) {
        if (hi === 0n) return 0n
        lo = hi > step ? hi - step : 0n
        if ((await this.timestamp(lo)) < t) break
        hi = lo
        step *= 4n
      }
    } else {
      lo = guess
      for (;;) {
        hi = lo + step < head.number ? lo + step : head.number
        if ((await this.timestamp(hi)) >= t) break
        lo = hi
        step *= 4n
      }
    }
    let loTs = await this.timestamp(lo)
    let hiTs = await this.timestamp(hi)
    // 2. Interpolation search with a bisection fallback.
    let bisect = false
    while (hi - lo > 1n) {
      if (bisect || hiTs === loTs) guess = lo + (hi - lo) / 2n
      else guess = lo + (BigInt(t - loTs) * (hi - lo)) / BigInt(hiTs - loTs)
      if (guess <= lo) guess = lo + 1n
      if (guess >= hi) guess = hi - 1n
      const before = hi - lo
      const gts = await this.timestamp(guess)
      if (gts < t) {
        lo = guess
        loTs = gts
      } else {
        hi = guess
        hiTs = gts
      }
      // Interpolation that fails to halve the interval switches to bisection for one step.
      bisect = !bisect && (hi - lo) * 2n > before
    }
    return hi
  }

  /** [start, end) → inclusive block range, or null if no block falls inside. */
  async blockRange(periodStart: number, periodEnd: number, head: BlockHeader): Promise<{ from: bigint; to: bigint } | null> {
    const from = await this.firstBlockAtOrAfter(periodStart, head)
    const to = (await this.firstBlockAtOrAfter(periodEnd, head)) - 1n
    return to >= from ? { from, to } : null
  }
}
