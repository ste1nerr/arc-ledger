/**
 * Record real Arc mainnet RPC responses as test fixtures (test/fixtures/*.json).
 * Uses only the full-archive public endpoints so replays do not depend on pruning.
 *
 * Usage: pnpm record-fixtures
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address } from 'viem'
import { PUBLIC_ENDPOINTS } from '../src/config/arc'
import { fetchLedger } from '../src/chain/ledger'
import { recordingRpc, type RpcFixture } from '../src/chain/replay'
import { createRpc } from '../src/chain/rpc'

const ARCHIVE = PUBLIC_ENDPOINTS.filter((e) => e.recentOnly === undefined)
const base = createRpc(ARCHIVE)

async function blockTs(n: bigint): Promise<number> {
  const b = await base.call<{ timestamp: string }>('eth_getBlockByNumber', [`0x${n.toString(16)}`, false])
  return parseInt(b.timestamp, 16)
}

interface Spec {
  name: string
  description: string
  address: Address
  fromBlock: bigint
  toBlock: bigint // period end = timestamp of this block (exclusive)
}

const SPECS: Spec[] = [
  {
    name: 'business',
    description:
      'EOA 0x01de…687d over ~24h: Memo-wrapped payments, a tx with two USDC outflows, USDC/EURC swaps (multi-transfer tx), relayer-paid outflows (fee not ours), CCTP mints and transferFrom inflows.',
    address: '0x01de545e8fea5ecaab78ec2c09e6d98117f7687d',
    fromBlock: 22_552_000n,
    toBlock: 22_726_000n,
  },
  {
    name: 'native',
    description: 'EOA 0x8c0a…c7b9 sending a plain native USDC transfer of 0.000004696512057275 USDC (below the 6-decimal ERC-20 precision).',
    address: '0x8c0ae4c99b48f24916b16c43490486016efcc7b9',
    fromBlock: 22_741_000n,
    toBlock: 22_741_200n,
  },
]

for (const spec of SPECS) {
  const calls: Record<string, unknown> = {}
  const rpc = recordingRpc(base, calls)
  const periodStart = await blockTs(spec.fromBlock)
  const periodEnd = await blockTs(spec.toBlock)
  console.log(`Recording ${spec.name}: ${spec.address} [${periodStart}, ${periodEnd})`)
  const result = await fetchLedger(spec.address, periodStart, periodEnd, {
    rpc,
    assets: ['USDC', 'EURC'],
    concurrency: 2,
    onProgress: (p) => process.stderr.write(`\r  ${p.phase} ${p.done}/${p.total}      `),
  })
  process.stderr.write('\n')
  const fixture: RpcFixture = {
    name: spec.name,
    description: spec.description,
    recordedAt: new Date().toISOString(),
    address: spec.address,
    periodStart,
    periodEnd,
    assets: ['USDC', 'EURC'],
    endpoints: ARCHIVE.map((e) => ({ url: e.url, maxLogRange: e.maxLogRange.toString(), pool: e.pool, rps: e.rps })),
    calls,
  }
  const file = join(import.meta.dirname, '../test/fixtures', `${spec.name}.json`)
  writeFileSync(file, JSON.stringify(fixture, null, 1) + '\n')
  console.log(`  ${result.report.rows.length} rows, ${Object.keys(calls).length} calls, ${result.stats.ms} ms → ${file}`)
  console.log(`  totals ${JSON.stringify(result.report.totals)}`)
  console.log(`  reconciliation ${JSON.stringify(result.report.reconciliation)}`)
}
