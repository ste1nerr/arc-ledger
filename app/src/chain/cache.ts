/**
 * In-memory cache of immutable RPC answers (Arc has deterministic finality, so a result
 * for an explicit block never changes). Lets "Retry" resume a long scan where it stopped.
 * Memory only: nothing is persisted.
 */
import type { CallOptions, Rpc } from './rpc'

const MAX_ENTRIES = 50_000
const store = new Map<string, unknown>()

const isHexBlock = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)

/** True when the answer is fixed forever: explicit block numbers or tx hashes only. */
export function cacheable(method: string, params: unknown[]): boolean {
  switch (method) {
    case 'eth_getLogs': {
      const f = params[0] as { fromBlock?: unknown; toBlock?: unknown } | undefined
      return !!f && isHexBlock(f.fromBlock) && isHexBlock(f.toBlock)
    }
    case 'eth_getTransactionReceipt':
      return true
    case 'eth_getBlockByNumber':
      return isHexBlock(params[0])
    case 'eth_getBalance':
    case 'eth_getTransactionCount':
    case 'eth_call':
      return isHexBlock(params[1])
    default:
      return false
  }
}

export function cachingRpc(inner: Rpc): Rpc {
  return {
    pools: () => inner.pools(),
    endpoints: () => inner.endpoints(),
    async call<T>(method: string, params: unknown[], opts?: CallOptions): Promise<T> {
      if (!cacheable(method, params)) return inner.call<T>(method, params, opts)
      const key = `${method} ${JSON.stringify(params)}`
      if (store.has(key)) return store.get(key) as T
      const result = await inner.call<T>(method, params, opts)
      if (result !== null) {
        if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value!)
        store.set(key, result)
      }
      return result
    },
  }
}

export const clearRpcCache = () => store.clear()
