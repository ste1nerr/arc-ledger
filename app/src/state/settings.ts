import { PUBLIC_ENDPOINTS, type RpcEndpoint } from '../config/arc'
import { createRpc, type Rpc } from '../chain/rpc'
import { readJson, writeJson } from './storage'

const RPC_KEY = 'arc-ledger:custom-rpc:v1'

export const loadCustomRpc = (): string => readJson<string>(RPC_KEY, '')
export const saveCustomRpc = (url: string) => writeJson(RPC_KEY, url.trim())

export function validRpcUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
  } catch {
    return false
  }
}

const cache = new Map<string, Rpc>() // one client (and one rate limiter) per endpoint set

/** Public Arc endpoints by default; a user-supplied archive RPC (e.g. their own free key) if set. */
export function getRpc(customUrl = loadCustomRpc()): Rpc {
  const custom = customUrl && validRpcUrl(customUrl) ? customUrl : ''
  const key = custom || 'public'
  let rpc = cache.get(key)
  if (!rpc) {
    const endpoints: RpcEndpoint[] = custom ? [{ url: custom, maxLogRange: 10_000n, pool: 'custom', rps: 8 }] : PUBLIC_ENDPOINTS
    rpc = createRpc(endpoints)
    cache.set(key, rpc)
  }
  return rpc
}

/** Always the public endpoints, for registry reads (Verify must not depend on user settings). */
export function publicRpc(): Rpc {
  return getRpc('')
}
