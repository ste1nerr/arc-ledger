/**
 * Minimal JSON-RPC client for the browser: per-pool adaptive rate limiting (AIMD),
 * retries with exponential backoff, endpoint rotation and AbortSignal support.
 * Public Arc RPCs allow ~1–2 eth_getLogs calls/s per IP (docs/ARC_FACTS.md §1).
 */
import type { RpcEndpoint } from '../config/arc'

export interface CallOptions {
  signal?: AbortSignal
  /** Restrict to endpoints of this pool (e.g. the pruned-but-fast one). */
  pool?: string
}

export interface Rpc {
  call<T>(method: string, params: unknown[], opts?: CallOptions): Promise<T>
  pools(): string[]
  endpoints(): readonly RpcEndpoint[]
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

export function abortError(): DOMException {
  return new DOMException('The operation was cancelled.', 'AbortError')
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Additive-increase / multiplicative-decrease request pacing. */
export class RateLimiter {
  private next = 0
  private rps: number
  constructor(
    initialRps: number,
    private readonly minRps = 0.3,
    private readonly maxRps = initialRps * 3,
  ) {
    this.rps = initialRps
  }
  get rate() {
    return this.rps
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    const now = Date.now()
    const slot = Math.max(now, this.next)
    this.next = slot + 1000 / this.rps
    if (slot > now) await sleep(slot - now, signal)
  }
  onSuccess() {
    this.rps = Math.min(this.maxRps, this.rps + 0.05)
  }
  onThrottle() {
    this.rps = Math.max(this.minRps, this.rps / 2)
    this.next = Math.max(this.next, Date.now() + 1000 / this.rps)
  }
}

export function isRateLimit(e: unknown): boolean {
  if (e instanceof RpcError) return e.code === -32005 || e.code === 429 || /rate limit|too many requests/i.test(e.message)
  return false
}

/** "range too large" / "max results" style errors: caller should split the block range. */
export function isRangeError(e: unknown): boolean {
  return e instanceof RpcError && /range|max results|too many results|limit exceeded.*logs|block range/i.test(e.message) && !isRateLimit(e)
}

export function isPruned(e: unknown): boolean {
  return e instanceof RpcError && (e.code === 4444 || /pruned|missing trie node|history (is )?not available/i.test(e.message))
}

interface Pool {
  name: string
  limiter: RateLimiter
  endpoints: RpcEndpoint[]
  cursor: number
}

export interface RpcOptions {
  maxAttempts?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  onRequest?: (info: { method: string; url: string }) => void
}

export function createRpc(endpoints: RpcEndpoint[], opts: RpcOptions = {}): Rpc {
  if (endpoints.length === 0) throw new Error('no RPC endpoints')
  const maxAttempts = opts.maxAttempts ?? 8
  const timeoutMs = opts.timeoutMs ?? 30_000
  const doFetch = opts.fetchImpl ?? fetch.bind(globalThis)
  const pools = new Map<string, Pool>()
  for (const ep of endpoints) {
    let p = pools.get(ep.pool)
    if (!p) pools.set(ep.pool, (p = { name: ep.pool, limiter: new RateLimiter(ep.rps), endpoints: [], cursor: 0 }))
    p.endpoints.push(ep)
  }
  const defaultPool = [...pools.values()].find((p) => p.endpoints.every((e) => e.recentOnly === undefined)) ?? [...pools.values()][0]!
  let id = 0

  async function once<T>(ep: RpcEndpoint, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const onAbort = () => ctrl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      opts.onRequest?.({ method, url: ep.url })
      const res = await doFetch(ep.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: ctrl.signal,
      })
      if (res.status === 429) throw new RpcError('HTTP 429 Too Many Requests', 429)
      if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${new URL(ep.url).host}`, res.status)
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } }
      if (body.error) throw new RpcError(body.error.message, body.error.code, body.error.data)
      if (!('result' in body)) throw new RpcError('Malformed JSON-RPC response', null)
      return body.result as T
    } catch (e) {
      if (signal?.aborted) throw abortError()
      if (e instanceof DOMException && e.name === 'AbortError') throw new RpcError(`Timed out after ${timeoutMs / 1000}s (${new URL(ep.url).host})`, null)
      if (e instanceof TypeError) throw new RpcError(`Network error calling ${new URL(ep.url).host}: ${e.message}`, null)
      throw e
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    pools: () => [...pools.keys()],
    endpoints: () => endpoints,
    async call<T>(method: string, params: unknown[], callOpts: CallOptions = {}): Promise<T> {
      const pool = callOpts.pool ? pools.get(callOpts.pool) : defaultPool
      if (!pool) throw new Error(`unknown RPC pool ${callOpts.pool}`)
      let lastError: unknown
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await pool.limiter.acquire(callOpts.signal)
        const ep = pool.endpoints[pool.cursor % pool.endpoints.length]!
        try {
          const result = await once<T>(ep, method, params, callOpts.signal)
          pool.limiter.onSuccess()
          return result
        } catch (e) {
          if (isAbort(e) || callOpts.signal?.aborted) throw abortError()
          // Deterministic errors go straight back to the caller (it may split the range or fall back).
          if (isRangeError(e) || isPruned(e)) throw e
          if (e instanceof RpcError && e.code !== null && e.code < 0 && !isRateLimit(e) && e.code !== -32603) throw e
          lastError = e
          if (isRateLimit(e)) pool.limiter.onThrottle()
          else pool.cursor++ // network / 5xx: try the next endpoint of the pool
          await sleep(Math.min(8_000, 400 * 2 ** attempt) * (0.75 + Math.random() / 2), callOpts.signal)
        }
      }
      throw lastError instanceof Error ? lastError : new RpcError(String(lastError), null)
    },
  }
}
