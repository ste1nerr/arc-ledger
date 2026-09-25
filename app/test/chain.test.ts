import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BlockClock } from '../src/chain/blocks'
import { decodeMemoData, fetchLedger, windows } from '../src/chain/ledger'
import { createRpc, isRangeError, RpcError, type Rpc } from '../src/chain/rpc'
import type { RpcEndpoint } from '../src/config/arc'

const EP: RpcEndpoint = { url: 'https://rpc.test', maxLogRange: 10_000n, pool: 'p', rps: 1000 }

function fakeFetch(responses: (object | number)[]) {
  const bodies: unknown[] = []
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    const next = responses.shift()
    if (next === undefined) throw new Error('no more responses')
    if (typeof next === 'number') return new Response('busy', { status: next })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...next }), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, bodies }
}

describe('createRpc', () => {
  it('retries rate limits and HTTP 429, then succeeds', async () => {
    const { impl, bodies } = fakeFetch([{ error: { code: -32005, message: 'rate limit exceeded' } }, 429, { result: '0x13b2' }])
    const rpc = createRpc([EP], { fetchImpl: impl })
    expect(await rpc.call('eth_chainId', [])).toBe('0x13b2')
    expect(bodies).toHaveLength(3)
  })

  it('passes range errors straight to the caller (no retry)', async () => {
    const { impl, bodies } = fakeFetch([{ error: { code: -32012, message: 'requested range too large' } }])
    const rpc = createRpc([EP], { fetchImpl: impl })
    const err = await rpc.call('eth_getLogs', [{}]).catch((e) => e)
    expect(isRangeError(err)).toBe(true)
    expect(bodies).toHaveLength(1)
  })

  it('does not treat a rate limit as a range error', () => {
    expect(isRangeError(new RpcError('rate limit exceeded', -32005))).toBe(false)
    expect(isRangeError(new RpcError('query exceeds max results 2000, retry with the range 1-2', -32602))).toBe(true)
  })

  it('rotates to the next endpoint on network errors', async () => {
    const urls: string[] = []
    const impl = (async (url: string) => {
      urls.push(url)
      if (url.includes('bad')) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }))
    }) as unknown as typeof fetch
    const rpc = createRpc([{ ...EP, url: 'https://bad.test' }, { ...EP, url: 'https://good.test' }], { fetchImpl: impl })
    expect(await rpc.call('eth_blockNumber', [])).toBe('0x1')
    expect(urls).toEqual(['https://bad.test', 'https://good.test'])
  })

  it('gives up after maxAttempts with the last error', async () => {
    const { impl } = fakeFetch([500, 500, 500])
    const rpc = createRpc([EP], { fetchImpl: impl, maxAttempts: 3 })
    await expect(rpc.call('eth_blockNumber', [])).rejects.toThrow(/HTTP 500/)
  })

  it('aborts while waiting', async () => {
    const { impl } = fakeFetch([429, 429, 429, 429])
    const rpc = createRpc([EP], { fetchImpl: impl })
    const ctrl = new AbortController()
    const p = rpc.call('eth_blockNumber', [], { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 20)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('windows()', () => {
  it('covers the range exactly with bounded windows (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 8n }), fc.bigInt({ min: 0n, max: 200_000n }), fc.bigInt({ min: 1n, max: 20_000n }), (from, len, size) => {
        const to = from + len
        const w = windows(from, to, size)
        expect(w[0]![0]).toBe(from)
        expect(w.at(-1)![1]).toBe(to)
        for (let i = 0; i < w.length; i++) {
          const [a, b] = w[i]!
          expect(b - a + 1n <= size).toBe(true)
          if (i > 0) expect(a).toBe(w[i - 1]![1] + 1n)
        }
      }),
    )
  })
})

/** Rpc over a synthetic chain whose timestamps are non-decreasing with repeats. */
function syntheticChain(timestamps: number[]): Rpc & { calls: number } {
  const state = {
    calls: 0,
    pools: () => ['p'],
    endpoints: () => [EP],
    async call<T>(method: string, params: unknown[]): Promise<T> {
      state.calls++
      if (method === 'eth_blockNumber') return `0x${(timestamps.length - 1).toString(16)}` as T
      if (method === 'eth_getBlockByNumber') {
        const n = parseInt(params[0] as string, 16)
        return { timestamp: `0x${timestamps[n]!.toString(16)}` } as T
      }
      throw new Error(method)
    },
  }
  return state
}

describe('BlockClock.firstBlockAtOrAfter', () => {
  it('matches a linear scan on arbitrary non-decreasing timestamps (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 2, maxLength: 400 }), fc.integer({ min: 0, max: 1300 }), async (steps, t) => {
        const ts: number[] = []
        steps.reduce((acc, s) => (ts.push(acc + s), acc + s), 1_700_000_000)
        const target = 1_700_000_000 + t
        const clock = new BlockClock(syntheticChain(ts))
        const head = await clock.head()
        const expected = ts.findIndex((x) => x >= target)
        const got = await clock.firstBlockAtOrAfter(target, head)
        expect(got).toBe(expected === -1 ? BigInt(ts.length) : BigInt(expected))
      }),
      { numRuns: 300 },
    )
  })

  it('needs few calls on a realistic chain (~0.5 s blocks, 22M blocks)', async () => {
    const N = 22_000_000
    const chain = syntheticChain([])
    const tsOf = (n: number) => 1_778_853_531 + Math.floor(n * 0.507)
    chain.call = (async (method: string, params: unknown[]) => {
      chain.calls++
      if (method === 'eth_blockNumber') return `0x${N.toString(16)}`
      return { timestamp: `0x${tsOf(parseInt(params[0] as string, 16)).toString(16)}` }
    }) as Rpc['call']
    const clock = new BlockClock(chain)
    const head = await clock.head()
    const range = await clock.blockRange(tsOf(15_000_000), tsOf(20_000_000), head)
    expect(range!.from <= 15_000_000n && range!.to < 20_000_000n).toBe(true)
    expect(clock.calls).toBeLessThan(80)
  })
})

describe('decodeMemoData', () => {
  it('decodes the ABI-encoded memo bytes from a real mainnet Memo event', () => {
    // tx 0x00be75d9…1b0f, log 9: callDataHash, offset 0x60, memoIndex 486, len 12, "cycles_sweep"
    const data =
      '0x' +
      'c6ae27638d5f76d2c6ddc9bd03397a8b77e0c605600d8a6e2a36df37526e148a' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '00000000000000000000000000000000000000000000000000000000000001e6' +
      '000000000000000000000000000000000000000000000000000000000000000c' +
      '6379636c65735f73776565700000000000000000000000000000000000000000'
    expect(decodeMemoData(data)).toBe('0x6379636c65735f7377656570')
  })
})

describe('fetchLedger input validation', () => {
  const rpc = syntheticChain([1, 2, 3])
  it('rejects an empty asset list and an inverted period', async () => {
    await expect(fetchLedger('0x0000000000000000000000000000000000000001', 10, 20, { rpc, assets: [] })).rejects.toThrow(/at least one asset/)
    await expect(fetchLedger('0x0000000000000000000000000000000000000001', 20, 10, { rpc })).rejects.toThrow(/after its start/)
  })
})
