/** Arc mainnet constants. Every value is sourced in docs/ARC_FACTS.md. */
import { defineChain, type Address } from 'viem'

export const ARC_CHAIN_ID = 5042

export const arcMainnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

export const EXPLORER_URL = 'https://explorer.arc.io'

/** EIP-7708 system emitter: every native USDC movement, 18 decimals. */
export const NATIVE_USDC_EMITTER: Address = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'
/** ERC-20 view of USDC (6 decimals). Its Transfer logs duplicate the native stream and are ignored. */
export const USDC_ERC20: Address = '0x3600000000000000000000000000000000000000'
export const EURC: Address = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
export const MEMO_CONTRACT: Address = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505'

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const MEMO_TOPIC = '0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4'

export type Asset = 'USDC' | 'EURC'
export const ASSETS: readonly Asset[] = ['EURC', 'USDC'] // canonical (sorted) order

export const ASSET_DECIMALS: Record<Asset, number> = { USDC: 18, EURC: 6 }
export const ASSET_EMITTER: Record<Asset, Address> = { USDC: NATIVE_USDC_EMITTER, EURC }

/** Measured average block time (docs/ARC_FACTS.md §2). Used only as a search hint. */
export const BLOCK_TIME_MS_HINT = 507

export interface RpcEndpoint {
  url: string
  /** Max inclusive block span per eth_getLogs call. */
  maxLogRange: bigint
  /** Only blocks within this distance of head are served (pruned node); undefined = full archive. */
  recentOnly?: bigint
  /** Endpoints with the same pool share one rate budget. */
  pool: string
  /** Starting request rate (per second); adapted at runtime. */
  rps: number
}

export const PUBLIC_ENDPOINTS: RpcEndpoint[] = [
  { url: 'https://rpc.mainnet.arc.io', maxLogRange: 10_000n, pool: 'arc-public', rps: 2 },
  { url: 'https://rpc.quicknode.mainnet.arc.io', maxLogRange: 10_000n, pool: 'arc-public', rps: 2 },
  // Pruned (kept depth varied 240k–730k blocks when measured), but allows 100k-block log ranges: great for recent periods.
  { url: 'https://rpc.blockdaemon.mainnet.arc.io', maxLogRange: 100_000n, recentOnly: 200_000n, pool: 'blockdaemon', rps: 2 },
]

/** Deployed PeriodCloseRegistry. Set after the owner deploys it (docs/ARC_FACTS.md §10). */
export const PERIOD_CLOSE_REGISTRY: Address | null = null
