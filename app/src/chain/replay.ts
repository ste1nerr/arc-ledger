/**
 * Record/replay wrappers around Rpc, used to capture real mainnet responses as test fixtures
 * (scripts/record-fixtures.ts) and to replay them deterministically in tests.
 */
import type { RpcEndpoint } from '../config/arc'
import type { CallOptions, Rpc } from './rpc'

export interface RpcFixture {
  name: string
  description: string
  recordedAt: string
  address: string
  periodStart: number
  periodEnd: number
  assets: ('USDC' | 'EURC')[]
  endpoints: { url: string; maxLogRange: string; recentOnly?: string; pool: string; rps: number }[]
  calls: Record<string, unknown>
}

export const callKey = (method: string, params: unknown[]) => `${method} ${JSON.stringify(params)}`

export function recordingRpc(inner: Rpc, calls: Record<string, unknown>): Rpc {
  return {
    pools: () => inner.pools(),
    endpoints: () => inner.endpoints(),
    async call<T>(method: string, params: unknown[], opts?: CallOptions): Promise<T> {
      const result = await inner.call<T>(method, params, opts)
      calls[callKey(method, params)] = result
      return result
    },
  }
}

export function replayRpc(fixture: RpcFixture): Rpc & { misses: string[] } {
  const endpoints: RpcEndpoint[] = fixture.endpoints.map((e) => ({
    url: e.url,
    maxLogRange: BigInt(e.maxLogRange),
    ...(e.recentOnly ? { recentOnly: BigInt(e.recentOnly) } : {}),
    pool: e.pool,
    rps: e.rps,
  }))
  const misses: string[] = []
  return {
    misses,
    pools: () => [...new Set(endpoints.map((e) => e.pool))],
    endpoints: () => endpoints,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const key = callKey(method, params)
      if (!(key in fixture.calls)) {
        misses.push(key)
        throw new Error(`fixture "${fixture.name}" has no recorded response for ${key}`)
      }
      return structuredClone(fixture.calls[key]) as T
    },
  }
}
